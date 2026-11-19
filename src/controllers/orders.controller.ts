import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { ObjectId, type Document } from "mongodb";
import { z } from "zod";

import { collections } from "../config/database.js";
import {
  sendNewOrderEmails,
  sendOrderStatusEmail,
} from "../services/email.service.js";
import {
  asyncHandler,
  badRequest,
  conflict,
  forbidden,
  notFound,
} from "../utils/errors.js";
import { firstString, getPagination, isValidObjectId } from "../utils/query.js";
import { orderDto } from "../utils/serialize.js";
import {
  ACTIVE_ORDER_STATUSES,
  type OrderDoc,
  type OrderStatus,
  type TimelineEntry,
} from "../types/models.js";

const createOrderSchema = z.object({
  menuItemId: z.string().regex(/^[a-fA-F0-9]{24}$/, "Invalid pizza"),
  quantity: z.number().int().min(1).max(20),
  deliveryAddress: z.string().trim().min(10).max(300),
  deliveryDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Select a valid delivery date"),
  message: z.string().trim().max(500).optional().default(""),
});

const statusSchema = z.object({
  status: z.enum(["preparing", "out_for_delivery", "delivered"]),
});

const dateIsValid = (value: string): boolean => {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return false;
  if (date.toISOString().slice(0, 10) !== value) return false;
  const today = new Date();
  const startOfToday = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  );
  return date.getTime() >= startOfToday.getTime();
};

const entry = (status: OrderStatus, by: TimelineEntry["by"], note?: string): TimelineEntry => ({
  status,
  by,
  note,
  at: new Date(),
});

const findOrderForRequest = async (
  req: Request,
): Promise<OrderDoc> => {
  if (!isValidObjectId(String(req.params.id))) throw notFound("Order not found");
  const order = await collections
    .orders()
    .findOne({ _id: new ObjectId(String(req.params.id)) });
  if (!order) throw notFound("Order not found");

  const user = req.user!;
  const allowed =
    user.role === "admin" ||
    (user.role === "customer" && order.customerId === user.id) ||
    (user.role === "vendor" && order.vendorId === user.id);
  if (!allowed) throw forbidden("You cannot access this order");
  return order;
};

export const createOrder = asyncHandler(async (req: Request, res: Response) => {
  if (req.user!.role !== "customer") {
    throw forbidden("Only customers can place orders");
  }

  const data = createOrderSchema.parse(req.body);
  if (!dateIsValid(data.deliveryDate)) {
    throw badRequest("Delivery date must be today or a future date");
  }

  const item = await collections.menuItems().findOne({
    _id: new ObjectId(data.menuItemId),
    approvalStatus: "approved",
    isActive: true,
  });
  if (!item) throw notFound("This pizza is not available for ordering");

  // The vendor comes from the database, never from the request body.
  if (item.vendorId === req.user!.id) {
    throw forbidden("Vendors cannot order their own menu items");
  }

  const vendor = await collections
    .users()
    .findOne({ _id: new ObjectId(item.vendorId) });
  if (!vendor || vendor.isBlocked || vendor.role !== "vendor") {
    throw notFound("This restaurant is currently unavailable");
  }

  // Keep a human-readable restaurant label on the order so history survives
  // even if the menu item or restaurant is later removed.
  const restaurant = item.restaurantId
    ? await collections
        .restaurants()
        .findOne({ _id: item.restaurantId }, { projection: { name: 1 } })
    : null;

  const now = new Date();
  const orderNumber = `PH-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(3).toString("hex").toUpperCase()}`;
  const totalPrice = Math.round(item.price * data.quantity * 100) / 100;

  const order: OrderDoc = {
    _id: new ObjectId(),
    orderNumber,
    customerId: req.user!.id,
    vendorId: item.vendorId,
    menuItemId: item._id,
    quantity: data.quantity,
    unitPrice: item.price,
    totalPrice,
    deliveryAddress: data.deliveryAddress,
    deliveryDate: data.deliveryDate,
    message: data.message,
    status: "pending",
    timeline: [entry("pending", "customer", "Order placed")],
    activeOrderKey: `${req.user!.id}:${item._id.toHexString()}:${data.deliveryDate}`,
    customerSnapshot: {
      name: req.user!.name,
      email: req.user!.email,
      image: req.user!.image ?? null,
    },
    menuItemSnapshot: {
      name: item.name,
      image: item.image,
      price: item.price,
      restaurantName: restaurant?.name ?? null,
    },
    createdAt: now,
    updatedAt: now,
  };

  try {
    await collections.orders().insertOne(order);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === 11000
    ) {
      throw conflict("You already have an active order for this pizza on that date");
    }
    throw error;
  }

  // Email is a side effect of a successfully stored order. The service never
  // throws, but this guard keeps a provider outage from changing the API result.
  let email: Awaited<ReturnType<typeof sendNewOrderEmails>> | undefined;
  try {
    email = await sendNewOrderEmails({
      vendorEmail: vendor.email,
      vendorName: vendor.businessName?.trim() || vendor.name,
      customerName: order.customerSnapshot.name,
      customerEmail: order.customerSnapshot.email,
      orderNumber: order.orderNumber,
      itemName: order.menuItemSnapshot.name,
      restaurantName: restaurant?.name ?? order.menuItemSnapshot.restaurantName,
      quantity: order.quantity,
      unitPrice: order.unitPrice,
      totalPrice: order.totalPrice,
      deliveryAddress: order.deliveryAddress,
      deliveryDate: order.deliveryDate,
      message: order.message,
    });
  } catch (caught) {
    console.error(
      "[email] Unexpected new-order email failure:",
      caught instanceof Error ? caught.message : "unknown error",
    );
  }

  res.status(201).json({
    success: true,
    message: "Order placed successfully",
    order: orderDto(order),
    ...(email ? { email } : {}),
  });
});

/**
 * Resolves the current restaurant name for each order's menu item. Orders keep
 * a snapshot name too, so this is a best-effort live enrichment only.
 */
const restaurantNamesForOrders = async (
  orders: OrderDoc[],
): Promise<Map<string, string>> => {
  const names = new Map<string, string>();
  if (orders.length === 0) return names;

  const items = await collections
    .menuItems()
    .find(
      { _id: { $in: orders.map((order) => order.menuItemId) } },
      { projection: { restaurantId: 1 } },
    )
    .toArray();
  const restaurantIds = items
    .map((item) => item.restaurantId)
    .filter((value): value is ObjectId => value instanceof ObjectId);
  if (restaurantIds.length === 0) return names;

  const restaurants = await collections
    .restaurants()
    .find(
      { _id: { $in: restaurantIds } },
      { projection: { name: 1 } },
    )
    .toArray();
  const restaurantNames = new Map(
    restaurants.map((restaurant) => [
      restaurant._id.toHexString(),
      restaurant.name,
    ]),
  );

  for (const item of items) {
    const restaurantName = item.restaurantId
      ? restaurantNames.get(item.restaurantId.toHexString())
      : undefined;
    if (restaurantName) names.set(item._id.toHexString(), restaurantName);
  }
  return names;
};

const listOrders = async (req: Request, res: Response, scope: "customer" | "vendor" | "all") => {
  const { page, limit } = getPagination(req);
  const status = firstString(req.query.status);
  const filter: Document = {};

  if (scope === "customer") filter.customerId = req.user!.id;
  if (scope === "vendor") filter.vendorId = req.user!.id;
  if (status && ACTIVE_ORDER_STATUSES.concat(["delivered", "cancelled", "rejected"]).includes(status as OrderStatus)) {
    filter.status = status;
  }

  const [orders, total] = await Promise.all([
    collections
      .orders()
      .find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    collections.orders().countDocuments(filter),
  ]);

  const names = await restaurantNamesForOrders(orders);
  res.json({
    success: true,
    orders: orders.map((order) =>
      orderDto(order, names.get(order.menuItemId.toHexString())),
    ),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
};

export const listMyOrders = asyncHandler((req: Request, res: Response) =>
  listOrders(req, res, "customer"),
);
export const listVendorOrders = asyncHandler((req: Request, res: Response) =>
  listOrders(req, res, "vendor"),
);
export const listAllOrders = asyncHandler((req: Request, res: Response) =>
  listOrders(req, res, "all"),
);

/**
 * New-order badge for the vendor dashboard. The seen marker lives on the
 * vendor's own user document, so counting is scoped to their orders and a
 * refresh/page reload cannot lose the state.
 */
export const getVendorUnseenOrderCount = asyncHandler(async (req: Request, res: Response) => {
  const vendorId = req.user!.id;
  const userFilter = { _id: new ObjectId(vendorId) };
  const user = await collections.users().findOne(userFilter);

  if (!user?.vendorOrdersSeenAt) {
    // First use: baseline at the newest existing order so historical orders
    // do not flood the badge. Later orders are counted on the next poll.
    const latest = await collections
      .orders()
      .find({ vendorId })
      .sort({ createdAt: -1 })
      .limit(1)
      .toArray();
    await collections.users().updateOne(userFilter, {
      $set: { vendorOrdersSeenAt: latest[0]?.createdAt ?? new Date() },
    });
    res.json({ success: true, count: 0 });
    return;
  }

  const count = await collections.orders().countDocuments({
    vendorId,
    createdAt: { $gt: user.vendorOrdersSeenAt },
  });
  res.json({ success: true, count });
});

export const markVendorOrdersSeen = asyncHandler(async (req: Request, res: Response) => {
  await collections.users().updateOne(
    { _id: new ObjectId(req.user!.id) },
    { $set: { vendorOrdersSeenAt: new Date() } },
  );
  res.json({ success: true });
});

export const getOrder = asyncHandler(async (req: Request, res: Response) => {
  const order = await findOrderForRequest(req);
  const names = await restaurantNamesForOrders([order]);
  res.json({
    success: true,
    order: orderDto(order, names.get(order.menuItemId.toHexString())),
  });
});

const changeStatus = async (
  req: Request,
  res: Response,
  nextStatus: OrderStatus,
  allowedFrom: OrderStatus[],
  by: TimelineEntry["by"],
  note: string,
) => {
  const order = await findOrderForRequest(req);
  if (!allowedFrom.includes(order.status)) {
    throw conflict(
      `This order cannot be updated from status "${order.status}" to "${nextStatus}"`,
    );
  }
  if (req.user!.role !== by && !(by === "vendor" && req.user!.role === "vendor")) {
    throw forbidden("You cannot perform this action");
  }

  const isTerminal = ["delivered", "cancelled", "rejected"].includes(nextStatus);
  const updated = await collections.orders().findOneAndUpdate(
    { _id: order._id },
    {
      $set: {
        status: nextStatus,
        timeline: [...order.timeline, entry(nextStatus, by, note)],
        updatedAt: new Date(),
      },
      ...(isTerminal ? { $unset: { activeOrderKey: "" } } : {}),
    },
    { returnDocument: "after" },
  );
  if (!updated) throw notFound("Order not found");
  const names = await restaurantNamesForOrders([updated]);
  const restaurantName =
    names.get(updated.menuItemId.toHexString()) ??
    updated.menuItemSnapshot.restaurantName ??
    null;

  let email: { sent: boolean; warning?: string } | undefined;
  if (nextStatus === "accepted" || nextStatus === "rejected") {
    email = await sendOrderStatusEmail({
      to: updated.customerSnapshot.email,
      customerName: updated.customerSnapshot.name,
      orderNumber: updated.orderNumber,
      itemName: updated.menuItemSnapshot.name,
      restaurantName,
      totalPrice: updated.totalPrice,
      deliveryDate: updated.deliveryDate,
      status: nextStatus,
    });
  }

  res.json({
    success: true,
    message: note,
    order: orderDto(updated, restaurantName ?? undefined),
    ...(email ? { email } : {}),
  });
};

export const cancelOrder = asyncHandler(async (req: Request, res: Response) => {
  if (req.user!.role !== "customer") {
    throw forbidden("Only the customer can cancel this order");
  }
  await changeStatus(req, res, "cancelled", ["pending"], "customer", "Order cancelled");
});

export const acceptOrder = asyncHandler(async (req: Request, res: Response) => {
  if (req.user!.role !== "vendor") {
    throw forbidden("Only the restaurant can accept orders");
  }
  await changeStatus(req, res, "accepted", ["pending"], "vendor", "Order accepted");
});

export const rejectOrder = asyncHandler(async (req: Request, res: Response) => {
  if (req.user!.role !== "vendor") {
    throw forbidden("Only the restaurant can reject orders");
  }
  await changeStatus(req, res, "rejected", ["pending"], "vendor", "Order rejected");
});

export const updateOrderStatus = asyncHandler(
  async (req: Request, res: Response) => {
    if (req.user!.role !== "vendor") {
      throw forbidden("Only the restaurant can update order status");
    }
    const { status } = statusSchema.parse(req.body);
    const transitions: Record<string, OrderStatus[]> = {
      preparing: ["accepted"],
      out_for_delivery: ["preparing"],
      delivered: ["out_for_delivery"],
    };
    const notes: Record<string, string> = {
      preparing: "Order is being prepared",
      out_for_delivery: "Order is out for delivery",
      delivered: "Order delivered",
    };
    await changeStatus(
      req,
      res,
      status,
      transitions[status]!,
      "vendor",
      notes[status]!,
    );
  },
);
