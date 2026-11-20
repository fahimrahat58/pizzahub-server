import type { Request, Response } from "express";
import { ObjectId, type Document } from "mongodb";
import { z } from "zod";

import { collections } from "../config/database.js";
import { sendOrderStatusEmail } from "../services/email.service.js";
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

export const statusSchema = z
  .object({
    status: z.enum(["preparing", "out_for_delivery", "delivered"]),
  })
  .strict();

/**
 * `deliveryDate` is a date-only string (YYYY-MM-DD), not a UTC instant. Compare
 * calendar dates using the server's configured delivery timezone (`TZ`) so a
 * delivery is not accepted a day early just because UTC is still yesterday.
 * Malformed legacy values are left deliverable rather than permanently stuck.
 */
const deliveryDateReached = (value: string, now: Date = new Date()): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return true;
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return value <= `${year}-${month}-${day}`;
};

const entry = (status: OrderStatus, by: TimelineEntry["by"], note?: string): TimelineEntry => ({
  status,
  by,
  note,
  at: new Date(),
});

type RequestUser = NonNullable<Request["user"]>;

const orderAccessFilter = (user: RequestUser): Document => {
  if (user.role === "customer") return { customerId: user.id };
  if (user.role === "vendor") return { vendorId: user.id };
  return {};
};

const canAccessOrder = (order: OrderDoc, user: RequestUser): boolean =>
  user.role === "admin" ||
  (user.role === "customer" && order.customerId === user.id) ||
  (user.role === "vendor" && order.vendorId === user.id);

const PAID_FULFILMENT_STATUSES: OrderStatus[] = [
  "accepted",
  "preparing",
  "out_for_delivery",
  "delivered",
];

const findOrderForRequest = async (
  req: Request,
): Promise<OrderDoc> => {
  if (!isValidObjectId(String(req.params.id))) throw notFound("Order not found");
  const orderId = new ObjectId(String(req.params.id));
  const user = req.user!;
  const accessFilter = orderAccessFilter(user);

  const order = await collections.orders().findOne({
    _id: orderId,
    ...accessFilter,
  });
  if (!order) {
    if (Object.keys(accessFilter).length === 0) {
      throw notFound("Order not found");
    }
    const exists = await collections.orders().findOne(
      { _id: orderId },
      { projection: { _id: 1 } },
    );
    if (!exists) throw notFound("Order not found");
    throw forbidden("You cannot access this order");
  }
  return order;
};

/**
 * Retired unpaid order write. The route stays mounted for a clear API error,
 * but no customer can create a fulfillable order outside Stripe Checkout.
 */
export const createOrder = asyncHandler(async (req: Request, _res: Response) => {
  if (req.user!.role !== "customer") {
    throw forbidden("Only customers can place orders");
  }
  throw badRequest(
    "Direct order placement is disabled. Add items to your cart and use Stripe Checkout.",
  );
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
 * New-order badge for the vendor dashboard. Seen state is stored per order,
 * not as a wall-clock timestamp on the vendor, so an order created on another
 * server instance (or while the Orders page is opening) cannot be swallowed
 * by clock skew or an in-flight request. The legacy timestamp is kept on the
 * user document for compatibility but is no longer used for counting.
 */
export const getVendorUnseenOrderCount = asyncHandler(async (req: Request, res: Response) => {
  const vendorId = req.user!.id;
  const userFilter = { _id: new ObjectId(vendorId) };
  const user = await collections.users().findOne(userFilter);

  if (!user?.vendorBadgeInitialized) {
    // First use (or upgrade from the legacy timestamp): existing orders are
    // already known to the vendor, so baseline them instead of flooding the
    // badge. Orders inserted after this point are unseen by default.
    await collections.orders().updateMany(
      { vendorId },
      { $set: { vendorSeen: true } },
    );
    await collections.users().updateOne(userFilter, {
      $set: { vendorBadgeInitialized: true },
    });
    res.json({ success: true, count: 0 });
    return;
  }

  const count = await collections.orders().countDocuments({
    vendorId,
    vendorSeen: { $ne: true },
  });
  res.json({ success: true, count });
});

export const markVendorOrdersSeen = asyncHandler(async (req: Request, res: Response) => {
  const vendorId = req.user!.id;
  await Promise.all([
    collections.orders().updateMany(
      { vendorId, vendorSeen: { $ne: true } },
      { $set: { vendorSeen: true } },
    ),
    collections.users().updateOne(
      { _id: new ObjectId(vendorId) },
      { $set: { vendorBadgeInitialized: true } },
    ),
  ]);
  // Return what is still unseen so an order inserted while this request was
  // running is not briefly hidden by the client's immediate "0" update.
  const count = await collections.orders().countDocuments({
    vendorId,
    vendorSeen: { $ne: true },
  });
  res.json({ success: true, count });
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
  const requiresVerifiedPayment = PAID_FULFILMENT_STATUSES.includes(nextStatus);
  if (requiresVerifiedPayment && order.paymentStatus !== "paid") {
    throw conflict("This order cannot be fulfilled until Stripe confirms payment");
  }
  if (req.user!.role !== by && !(by === "vendor" && req.user!.role === "vendor")) {
    throw forbidden("You cannot perform this action");
  }
  if (nextStatus === "delivered" && !deliveryDateReached(order.deliveryDate)) {
    throw badRequest(
      `This order cannot be marked as Delivered before the customer's requested delivery date (${order.deliveryDate}).`,
    );
  }

  const isTerminal = ["delivered", "cancelled", "rejected"].includes(nextStatus);
  const updated = await collections.orders().findOneAndUpdate(
    {
      _id: order._id,
      status: { $in: allowedFrom },
      ...(requiresVerifiedPayment ? { paymentStatus: "paid" } : {}),
      ...orderAccessFilter(req.user!),
    },
    [
      {
        $set: {
          status: nextStatus,
          timeline: {
            $concatArrays: [
              { $ifNull: ["$timeline", []] },
              [entry(nextStatus, by, note)],
            ],
          },
          updatedAt: new Date(),
        },
      },
      ...(isTerminal ? [{ $unset: "activeOrderKey" }] : []),
    ],
    { returnDocument: "after" },
  );
  if (!updated) {
    const current = await collections.orders().findOne(
      { _id: order._id },
      { projection: { status: 1, customerId: 1, vendorId: 1 } },
    );
    if (!current) throw notFound("Order not found");
    if (!canAccessOrder(current, req.user!)) {
      throw forbidden("You cannot access this order");
    }
    throw conflict(
      `This order cannot be updated from status "${current.status}" to "${nextStatus}"`,
    );
  }
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
