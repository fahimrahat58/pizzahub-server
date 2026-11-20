import type { Request, Response } from "express";
import { ObjectId, type Document } from "mongodb";
import { z } from "zod";

import { collections } from "../config/database.js";
import {
  createCheckout,
  getCheckoutStatus,
} from "../services/payment.service.js";
import { asyncHandler, forbidden, notFound } from "../utils/errors.js";
import { firstString, getPagination, isValidObjectId } from "../utils/query.js";
import { orderDto, transactionDto } from "../utils/serialize.js";
import type {
  OrderDoc,
  PaymentStatus,
  PaymentType,
  TransactionDoc,
} from "../types/models.js";

export const checkoutSchema = z
  .object({
    deliveryAddress: z.string().trim().min(10).max(300),
    deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Select a valid delivery date"),
    message: z.string().trim().max(500).optional().default(""),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();

const PAYMENT_STATUSES: PaymentStatus[] = ["pending", "paid", "failed", "refunded"];
const PAYMENT_TYPES: PaymentType[] = ["customer_order", "vendor_subscription"];
const PAYMENT_SORTS = ["newest", "oldest", "amount_desc", "amount_asc"] as const;
type PaymentSort = (typeof PAYMENT_SORTS)[number];

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const createOrderCheckout = asyncHandler(async (req: Request, res: Response) => {
  if (req.user!.role !== "customer") throw forbidden("Only customers can check out");
  const data = checkoutSchema.parse(req.body);
  const customer = await collections.users().findOne({
    _id: new ObjectId(req.user!.id),
    role: "customer",
  });
  if (!customer) throw notFound("Customer account not found");

  const result = await createCheckout(customer, data);
  res.status(201).json({
    success: true,
    message: result.reused ? "Existing checkout resumed" : "Checkout session created",
    checkoutUrl: result.session.url,
    sessionId: result.session.id,
    paymentStatus: result.order.paymentStatus ?? "pending",
    order: orderDto(result.order),
  });
});

export const getSession = asyncHandler(async (req: Request, res: Response) => {
  const sessionId = firstString(req.params.sessionId);
  if (!sessionId) throw notFound("Checkout session not found");
  const customerId = req.user!.role === "customer" ? req.user!.id : undefined;
  const { order, session } = await getCheckoutStatus(sessionId, customerId);
  res.setHeader("Cache-Control", "no-store");
  res.json({
    success: true,
    paymentStatus: order.paymentStatus ?? "pending",
    stripePaymentStatus: session.payment_status,
    stripeSessionStatus: session.status,
    order: orderDto(order),
  });
});

const listPayments = async (req: Request, res: Response) => {
  const { page, limit } = getPagination(req);
  const status = firstString(req.query.status);
  const type = firstString(req.query.type);
  const filter: Document = {
    customerId: req.user!.id,
    paymentType: "customer_order",
  };
  if (status && PAYMENT_STATUSES.includes(status as PaymentStatus)) {
    filter.paymentStatus = status;
  }
  if (type && PAYMENT_TYPES.includes(type as PaymentType)) {
    filter.paymentType = type;
  }

  const [transactions, total] = await Promise.all([
    collections
      .transactions()
      .find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    collections.transactions().countDocuments(filter),
  ]);

  res.json({
    success: true,
    transactions: transactions.map((transaction) => transactionDto(transaction)),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
};

/**
 * Vendor history is built from the authenticated vendor id and from orders the
 * database says that vendor owns. No client-supplied vendor id is ever read.
 * The aggregate returns the page plus DB-calculated summary stats in one query.
 */
const listVendorPayments = asyncHandler(async (req: Request, res: Response) => {
  const vendorId = req.user!.id;
  const { page, limit } = getPagination(req);
  const status = firstString(req.query.status);
  const type = firstString(req.query.type);
  const search = firstString(req.query.search)?.trim().slice(0, 100) ?? "";
  const restaurantId = firstString(req.query.restaurantId);
  const requestedSort = firstString(req.query.sort);
  const sort: PaymentSort = PAYMENT_SORTS.includes(requestedSort as PaymentSort)
    ? (requestedSort as PaymentSort)
    : "newest";

  const ownedOrders = (await collections
    .orders()
    .find(
      { vendorId },
      { projection: { orderNumber: 1, status: 1, createdAt: 1, restaurantId: 1 } },
    )
    .toArray()) as OrderDoc[];

  const filter: Document = { vendorId };
  const clauses: Document[] = [
    {
      $or: [
        { paymentType: { $ne: "customer_order" } },
        { orderId: { $in: ownedOrders.map((order) => order._id.toHexString()) } },
      ],
    },
  ];

  if (status && PAYMENT_STATUSES.includes(status as PaymentStatus)) {
    filter.paymentStatus = status;
  }
  if (type && PAYMENT_TYPES.includes(type as PaymentType)) {
    filter.paymentType = type;
  }

  if (restaurantId) {
    if (!isValidObjectId(restaurantId)) throw forbidden("Invalid restaurant filter");
    const restaurant = await collections.restaurants().findOne(
      { _id: new ObjectId(restaurantId), vendorId },
      { projection: { _id: 1 } },
    );
    if (!restaurant) throw forbidden("You can only view payments for your own restaurants");
    const orderIds = ownedOrders
      .filter((order) => order.restaurantId?.toHexString() === restaurantId)
      .map((order) => order._id.toHexString());
    clauses.push({ $or: [{ orderId: { $in: orderIds } }, { restaurantId }] });
  }

  if (search) {
    const pattern = new RegExp(escapeRegex(search), "i");
    const matchingOrderIds = ownedOrders
      .filter((order) =>
        (order.orderNumber ?? "").toLowerCase().includes(search.toLowerCase()),
      )
      .map((order) => order._id.toHexString());
    const searchClauses: Document[] = [
      { customerName: pattern },
      { customerEmail: pattern },
      { restaurantName: pattern },
      { description: pattern },
    ];
    if (isValidObjectId(search)) searchClauses.push({ orderId: search });
    if (matchingOrderIds.length) searchClauses.push({ orderId: { $in: matchingOrderIds } });
    clauses.push({ $or: searchClauses });
  }
  if (clauses.length) filter.$and = clauses;

  const sortStage: Document =
    sort === "oldest"
      ? { createdAt: 1, _id: 1 }
      : sort === "amount_desc"
        ? { amount: -1, createdAt: -1, _id: -1 }
        : sort === "amount_asc"
          ? { amount: 1, createdAt: -1, _id: -1 }
          : { createdAt: -1, _id: -1 };
  const effectiveStatus = { $ifNull: ["$paymentStatus", "$status"] };

  const [result] = (await collections
    .transactions()
    .aggregate([
      { $match: filter },
      { $sort: sortStage },
      {
        $facet: {
          items: [{ $skip: (page - 1) * limit }, { $limit: limit }],
          summary: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                customerOrders: {
                  $sum: { $cond: [{ $eq: ["$paymentType", "customer_order"] }, 1, 0] },
                },
                subscriptions: {
                  $sum: { $cond: [{ $eq: ["$paymentType", "vendor_subscription"] }, 1, 0] },
                },
                paidCount: { $sum: { $cond: [{ $eq: [effectiveStatus, "paid"] }, 1, 0] } },
                pendingCount: { $sum: { $cond: [{ $eq: [effectiveStatus, "pending"] }, 1, 0] } },
                failedCount: { $sum: { $cond: [{ $eq: [effectiveStatus, "failed"] }, 1, 0] } },
                refundedCount: {
                  $sum: { $cond: [{ $eq: [effectiveStatus, "refunded"] }, 1, 0] },
                },
                paidAmount: {
                  $sum: { $cond: [{ $eq: [effectiveStatus, "paid"] }, "$amount", 0] },
                },
                refundedAmount: { $sum: { $ifNull: ["$refundedAmount", 0] } },
              },
            },
          ],
        },
      },
    ])
    .toArray()) as {
    items: TransactionDoc[];
    summary: Array<{
      total: number;
      customerOrders: number;
      subscriptions: number;
      paidCount: number;
      pendingCount: number;
      failedCount: number;
      refundedCount: number;
      paidAmount: number;
      refundedAmount: number;
    }>;
  }[];

  const orderMap = new Map(ownedOrders.map((order) => [order._id.toHexString(), order]));
  const currency = result?.items[0]?.currency ?? "usd";
  const transactions = (result?.items ?? []).map((transaction) => {
    const order = transaction.orderId ? orderMap.get(transaction.orderId) : undefined;
    // Keep the masked reference for vendors, but never send the full address.
    return { ...transactionDto(transaction, {
      orderNumber: order?.orderNumber ?? null,
      orderCreatedAt: order?.createdAt ?? null,
      orderStatus: order?.status ?? null,
    }), customerEmail: null };
  });
  const summary = result?.summary[0] ?? {
    total: 0,
    customerOrders: 0,
    subscriptions: 0,
    paidCount: 0,
    pendingCount: 0,
    failedCount: 0,
    refundedCount: 0,
    paidAmount: 0,
    refundedAmount: 0,
  };
  const total = summary.total;

  res.json({
    success: true,
    transactions,
    summary: { ...summary, currency },
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

export const listMyPayments = asyncHandler((req: Request, res: Response) =>
  listPayments(req, res),
);
export { listVendorPayments };

export const getPayment = asyncHandler(async (req: Request, res: Response) => {
  const id = firstString(req.params.id);
  if (!id || !isValidObjectId(id)) throw notFound("Transaction not found");
  const transaction = await collections.transactions().findOne({
    _id: new ObjectId(id),
  });
  if (!transaction) throw notFound("Transaction not found");
  const user = req.user!;
  const allowed =
    user.role === "admin" ||
    (user.role === "customer" && transaction.customerId === user.id) ||
    (user.role === "vendor" && transaction.vendorId === user.id);
  if (!allowed) throw forbidden("You cannot access this transaction");
  const transactionPayload = transactionDto(transaction);
  if (user.role === "vendor") transactionPayload.customerEmail = null;
  res.json({ success: true, transaction: transactionPayload });
});
