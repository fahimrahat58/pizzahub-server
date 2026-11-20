import { createHash, randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import type Stripe from "stripe";

import { collections } from "../config/database.js";
import { env } from "../config/env.js";
import { getStripeForPayments } from "../config/stripe.js";
import {
  cartSummary,
  ORDER_CURRENCY,
  type CartDto,
} from "./cart.service.js";
import {
  sendPaidOrderEmails,
  sendPaymentFailedEmail,
  sendRefundEmail,
} from "./email.service.js";
import { badRequest, conflict, notFound } from "../utils/errors.js";
import { isValidObjectId } from "../utils/query.js";
import type {
  OrderDoc,
  PaymentStatus,
  RefundRecord,
  TransactionDoc,
  UserDoc,
} from "../types/models.js";

export interface CheckoutInput {
  deliveryAddress: string;
  deliveryDate: string;
  message?: string;
  idempotencyKey: string;
}

export interface CheckoutResult {
  order: OrderDoc;
  session: Stripe.Checkout.Session;
  reused: boolean;
}

const money = (value: number): number => Math.round(value * 100) / 100;
const cents = (value: number): number => Math.round(value * 100);

/**
 * Stable fingerprint of the customer's current cart. Two tabs with the same
 * items are therefore recognised as one checkout attempt, while a deliberately
 * rebuilt cart can start a new order after the previous one has settled.
 */
const cartFingerprint = (customerId: string, cart: CartDto): string => {
  const contents = cart.items
    .map((item) => ({
      menuItemId: item.menuItemId,
      vendorId: item.vendorId,
      restaurantId: item.restaurantId,
      quantity: item.quantity,
    }))
    .sort((a, b) => a.menuItemId.localeCompare(b.menuItemId));
  return createHash("sha256")
    .update(JSON.stringify({ customerId, restaurantId: cart.restaurantId, items: contents }))
    .digest("hex");
};

const idOf = (
  value: string | { id: string } | null | undefined,
): string | null => {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
};

const frontendOrigin = (): string => {
  const first = env.frontendUrl
    .split(",")
    .map((value) => value.trim())
    .find(Boolean);
  if (!first) throw new Error("FRONTEND_URL is not configured");
  return first.replace(/\/$/, "");
};

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

const orderNumber = (): string =>
  `PH-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(3).toString("hex").toUpperCase()}`;

const itemSummary = (order: OrderDoc): string =>
  order.items && order.items.length
    ? order.items.map((item) => `${item.quantity} × ${item.name}`).join(", ")
    : `${order.quantity} × ${order.menuItemSnapshot.name}`;

const sharedMetadata = (order: OrderDoc) => ({
  paymentType: "customer_order",
  orderId: order._id.toHexString(),
  customerId: order.customerId,
  vendorId: order.vendorId,
});

const lineItemsFor = (cart: CartDto): Stripe.Checkout.SessionCreateParams.LineItem[] => {
  const items: Stripe.Checkout.SessionCreateParams.LineItem[] = cart.items.map(
    (item) => ({
      quantity: item.quantity,
      price_data: {
        currency: ORDER_CURRENCY,
        unit_amount: cents(item.unitPrice),
        product_data: {
          name: item.name,
          ...(item.restaurantName
            ? { description: `From ${item.restaurantName}` }
            : {}),
          metadata: {
            menuItemId: item.menuItemId,
            ...(item.restaurantId ? { restaurantId: item.restaurantId } : {}),
          },
        },
      },
    }),
  );

  if (cart.deliveryFee > 0) {
    items.push({
      quantity: 1,
      price_data: {
        currency: ORDER_CURRENCY,
        unit_amount: cents(cart.deliveryFee),
        product_data: {
          name: "Delivery fee",
          description: "PizzaHub delivery",
        },
      },
    });
  }
  return items;
};

/**
 * Same-key retries and same-cart requests from another tab must land on the
 * original Checkout Session. A failed/expired session is released locally so
 * the customer can start a fresh attempt without waiting for a webhook.
 */
const reuseOpenCheckout = async (
  existing: OrderDoc,
  customerId: string,
): Promise<CheckoutResult> => {
  if (existing.customerId !== customerId) {
    throw conflict("This checkout is already being created");
  }
  if (!existing.stripeSessionId) {
    throw conflict("This checkout is already being created. Please retry shortly.");
  }
  if (existing.paymentStatus === "paid" || existing.paymentStatus === "refunded") {
    throw conflict("This checkout has already been paid");
  }

  const stripe = getStripeForPayments();
  const session = await stripe.checkout.sessions.retrieve(existing.stripeSessionId);
  if (session.payment_status === "paid") {
    // The webhook may still be in flight. Reconcile only from the Stripe
    // session we just verified so the customer is not trapped in a terminal
    // 409 while the local order is still pending.
    const reconciled = await applyCustomerCheckoutSucceeded(
      `reconcile:${session.id}`,
      session,
    );
    const paidOrder =
      reconciled ??
      (await collections.orders().findOne({ _id: existing._id }));
    if (paidOrder?.paymentStatus === "paid") {
      return { order: paidOrder, session, reused: true };
    }
    throw conflict("This checkout has already been paid");
  }
  if (session.status === "open" && session.url) {
    return { order: existing, session, reused: true };
  }

  if (session.status === "expired" && existing.paymentStatus === "pending") {
    await collections.orders().updateOne(
      {
        _id: existing._id,
        stripeSessionId: session.id,
        paymentStatus: "pending",
      },
      {
        $set: { paymentStatus: "failed", updatedAt: new Date() },
        $unset: { checkoutIdempotencyKey: "", checkoutCartKey: "" },
      },
    );
  }
  throw conflict("This checkout session has expired. Please start a new checkout.");
};

/**
 * Creates the pending order from a server-validated cart, then starts a Stripe
 * Checkout Session in one-time `payment` mode. No client-supplied price, total,
 * currency, or payment status is ever accepted.
 */
export const createCheckout = async (
  customer: UserDoc,
  input: CheckoutInput,
): Promise<CheckoutResult> => {
  if (!dateIsValid(input.deliveryDate)) {
    throw badRequest("Delivery date must be today or a future date");
  }
  if (!input.idempotencyKey || input.idempotencyKey.length > 200) {
    throw badRequest("A valid checkout idempotency key is required");
  }

  const customerId = customer._id.toHexString();
  const cart = await cartSummary(customerId);
  if (cart.items.length === 0) throw badRequest("Your cart is empty");

  const checkoutCartKey = cartFingerprint(customerId, cart);
  const activeCheckout = await collections.orders().findOne({
    customerId,
    checkoutCartKey,
    paymentStatus: "pending",
    paymentMethod: "stripe",
  });
  if (activeCheckout) return reuseOpenCheckout(activeCheckout, customerId);

  const first = cart.items[0]!;
  const vendor = await collections.users().findOne({
    _id: new ObjectId(first.vendorId),
    role: "vendor",
  });
  if (!vendor || vendor.isBlocked) {
    throw notFound("This restaurant is currently unavailable");
  }

  const now = new Date();
  const order: OrderDoc = {
    _id: new ObjectId(),
    orderNumber: orderNumber(),
    customerId: customer._id.toHexString(),
    vendorId: vendor._id.toHexString(),
    // Legacy required fields point at the first line item for compatibility.
    menuItemId: new ObjectId(first.menuItemId),
    quantity: cart.itemCount,
    unitPrice: first.unitPrice,
    totalPrice: cart.total,
    deliveryAddress: input.deliveryAddress,
    deliveryDate: input.deliveryDate,
    message: input.message ?? "",
    status: "pending",
    vendorSeen: false,
    timeline: [{ status: "pending", by: "customer", note: "Order placed", at: now }],
    customerSnapshot: {
      name: customer.name,
      email: customer.email,
      image: customer.image ?? null,
    },
    menuItemSnapshot: {
      name: first.name,
      image: first.image,
      price: first.unitPrice,
      restaurantName: cart.restaurantName,
    },
    restaurantId: cart.restaurantId ? new ObjectId(cart.restaurantId) : null,
    items: cart.items.map((item) => ({
      menuItemId: item.menuItemId,
      name: item.name,
      image: item.image,
      unitPrice: item.unitPrice,
      quantity: item.quantity,
      lineTotal: item.lineTotal,
      restaurantName: item.restaurantName,
    })),
    subtotal: cart.subtotal,
    deliveryFee: cart.deliveryFee,
    totalAmount: cart.total,
    currency: ORDER_CURRENCY,
    paymentMethod: "stripe",
    paymentStatus: "pending",
    checkoutIdempotencyKey: input.idempotencyKey,
    checkoutCartKey,
    createdAt: now,
    updatedAt: now,
  };

  let inserted = true;
  try {
    await collections.orders().insertOne(order);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === 11000
    ) {
      inserted = false;
    } else {
      throw error;
    }
  }

  if (!inserted) {
    // The unique checkout-key and active-cart indexes can both reject a
    // concurrent insert. Resolve either case to the original checkout attempt.
    const existing = await collections.orders().findOne({
      customerId,
      $or: [
        { checkoutIdempotencyKey: input.idempotencyKey },
        { checkoutCartKey },
      ],
    });
    if (!existing) throw conflict("This checkout is already being created");
    return reuseOpenCheckout(existing, customerId);
  }

  const stripe = getStripeForPayments();
  const origin = frontendOrigin();
  const metadata = sharedMetadata(order);
  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        line_items: lineItemsFor(cart),
        client_reference_id: customer._id.toHexString(),
        customer_email: customer.email,
        metadata,
        payment_intent_data: { metadata },
        success_url: `${origin}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/payment/cancel?session_id={CHECKOUT_SESSION_ID}`,
      },
      // Scope the Stripe key to this order as well as the client token. A new
      // attempt after expiry gets a new order id and cannot replay an old
      // Checkout Session from Stripe's 24-hour idempotency window.
      { idempotencyKey: `order-checkout-${order._id.toHexString()}-${input.idempotencyKey}` },
    );
  } catch (error) {
    // Do not leave a pending order behind when Stripe could not start checkout.
    await collections.orders().deleteOne({
      _id: order._id,
      paymentStatus: "pending",
      stripeSessionId: { $exists: false },
    });
    throw error;
  }

  await collections.orders().updateOne(
    { _id: order._id },
    { $set: { stripeSessionId: session.id, updatedAt: new Date() } },
  );

  return {
    order: { ...order, stripeSessionId: session.id },
    session,
    reused: false,
  };
};

/**
 * Success-page lookup. A settled order is authoritative from its verified
 * webhook state. For a still-pending order we retrieve the Checkout Session
 * from Stripe and, only when that server-verified snapshot proves it is the
 * paid session for this exact order, reconcile through the normal settlement
 * path. This keeps a missed/late webhook from trapping the customer on the
 * success page without ever trusting the browser redirect parameter alone.
 */
export const getCheckoutStatus = async (
  sessionId: string,
  customerId?: string,
): Promise<{ order: OrderDoc; session: Stripe.Checkout.Session }> => {
  const order = await collections.orders().findOne({
    stripeSessionId: sessionId,
    ...(customerId ? { customerId } : {}),
  });
  if (!order) throw notFound("Checkout session not found");

  if (order.paymentStatus === "paid" || order.paymentStatus === "refunded") {
    return {
      order,
      session: {
        id: sessionId,
        object: "checkout.session",
        mode: "payment",
        status: "complete",
        payment_status: "paid",
        amount_total: cents(order.totalAmount ?? order.totalPrice),
        currency: ORDER_CURRENCY,
        client_reference_id: order.customerId,
        metadata: sharedMetadata(order),
      } as unknown as Stripe.Checkout.Session,
    };
  }

  const stripe = getStripeForPayments();
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  const orderId = order._id.toHexString();
  const canReconcile =
    (order.paymentStatus == null || order.paymentStatus === "pending") &&
    session.mode === "payment" &&
    session.metadata?.paymentType === "customer_order" &&
    session.metadata?.orderId === orderId &&
    (!customerId || session.metadata?.customerId === customerId) &&
    session.payment_status === "paid";
  if (canReconcile) {
    await applyCustomerCheckoutSucceeded(`reconcile:${session.id}`, session);
    const settled = await collections.orders().findOne({ _id: order._id });
    return { order: settled ?? order, session };
  }
  return { order, session };
};

const resolveOrderFromMetadata = async (
  metadata: Stripe.Metadata | null | undefined,
  clientReferenceId?: string | null,
  sessionId?: string | null,
): Promise<OrderDoc | null> => {
  const orderId = metadata?.orderId ?? clientReferenceId ?? null;
  if (!orderId || !isValidObjectId(orderId)) return null;
  const order = await collections.orders().findOne({
    _id: new ObjectId(orderId),
  });
  if (!order) return null;
  if (metadata?.customerId && metadata.customerId !== order.customerId) return null;
  if (metadata?.vendorId && metadata.vendorId !== order.vendorId) return null;
  if (metadata?.paymentType && metadata.paymentType !== "customer_order") return null;
  // A signed event for a different Checkout Session must never settle this order.
  if (sessionId && order.stripeSessionId && order.stripeSessionId !== sessionId) {
    return null;
  }
  return order;
};

const sessionMatchesOrder = (
  session: Stripe.Checkout.Session,
  order: OrderDoc,
): boolean => {
  if (session.mode !== "payment") return false;
  if (!session.amount_total || session.amount_total < 0) return false;
  if (session.amount_total !== cents(order.totalAmount ?? order.totalPrice)) {
    return false;
  }
  if ((session.currency ?? ORDER_CURRENCY).toLowerCase() !== ORDER_CURRENCY) {
    return false;
  }
  if (
    session.client_reference_id &&
    session.client_reference_id !== order.customerId
  ) {
    return false;
  }
  return true;
};

const successfulPaymentIntentId = async (
  session: Stripe.Checkout.Session,
  order: OrderDoc,
): Promise<string | null> => {
  const paymentIntentId = idOf(session.payment_intent);
  if (!paymentIntentId) return null;
  const stripe = getStripeForPayments();
  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  if (paymentIntent.status !== "succeeded") return null;

  const expectedAmount = cents(order.totalAmount ?? order.totalPrice);
  if (
    paymentIntent.amount_received !== expectedAmount &&
    paymentIntent.amount !== expectedAmount
  ) {
    return null;
  }
  if ((paymentIntent.currency ?? ORDER_CURRENCY).toLowerCase() !== ORDER_CURRENCY) {
    return null;
  }
  const metadata = paymentIntent.metadata ?? {};
  if (metadata.paymentType && metadata.paymentType !== "customer_order") return null;
  if (metadata.orderId && metadata.orderId !== order._id.toHexString()) return null;
  if (metadata.customerId && metadata.customerId !== order.customerId) return null;
  return paymentIntent.id;
};

interface RecordOrderTransactionInput {
  eventId: string;
  order: OrderDoc;
  status: PaymentStatus;
  sessionId?: string | null;
  paymentIntentId?: string | null;
  description?: string | null;
}

/** One upsert per order keeps the centralized ledger free of duplicate rows. */
export const recordOrderTransaction = async (
  input: RecordOrderTransactionInput,
): Promise<void> => {
  const vendor = await collections.users().findOne({
    _id: new ObjectId(input.order.vendorId),
  });
  if (!vendor) return;

  const now = new Date();
  const document: TransactionDoc = {
    _id: new ObjectId(),
    paymentType: "customer_order",
    vendorId: vendor._id.toHexString(),
    vendorName: vendor.businessName?.trim() || vendor.name,
    vendorEmail: vendor.email,
    customerId: input.order.customerId,
    customerName: input.order.customerSnapshot.name,
    customerEmail: input.order.customerSnapshot.email,
    restaurantId: input.order.restaurantId?.toHexString() ?? null,
    restaurantName:
      input.order.menuItemSnapshot.restaurantName ?? "PizzaHub restaurant",
    orderId: input.order._id.toHexString(),
    amount: money(input.order.totalAmount ?? input.order.totalPrice),
    currency: (input.order.currency ?? ORDER_CURRENCY).toUpperCase(),
    status: input.status,
    paymentStatus: input.status,
    paymentMethod: "stripe",
    stripeEventId: input.eventId,
    stripeSessionId: input.sessionId ?? input.order.stripeSessionId ?? null,
    stripePaymentIntentId: input.paymentIntentId ?? null,
    description:
      input.description ??
      (input.status === "paid"
        ? "Customer order payment"
        : "Customer order payment failed"),
    refundedAmount: 0,
    refunds: [],
    createdAt: now,
    updatedAt: now,
  };

  const { _id, createdAt, ...values } = document;
  try {
    await collections.transactions().updateOne(
      { orderId: document.orderId },
      { $set: values, $setOnInsert: { _id, createdAt } },
      { upsert: true },
    );
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === 11000
    ) {
      // An earlier malformed delivery may own this Stripe event id with an
      // incomplete row and no order id. Repair that row instead of leaving the
      // authoritative paid transaction out of the ledger.
      const byEvent = await collections
        .transactions()
        .findOne({ stripeEventId: document.stripeEventId });
      if (byEvent && (!byEvent.orderId || byEvent.orderId === document.orderId)) {
        await collections.transactions().updateOne(
          { _id: byEvent._id },
          { $set: { ...values, orderId: document.orderId } },
        );
        return;
      }
      await collections.transactions().updateOne(
        { orderId: document.orderId },
        { $set: values },
      );
      return;
    }
    throw error;
  }
};

const paidEmailInput = (order: OrderDoc, paymentIntentId?: string | null) => ({
  vendorEmail: "",
  vendorName: "",
  customerEmail: order.customerSnapshot.email,
  customerName: order.customerSnapshot.name,
  orderNumber: order.orderNumber,
  itemSummary: itemSummary(order),
  restaurantName: order.menuItemSnapshot.restaurantName,
  amount: money(order.totalAmount ?? order.totalPrice),
  currency: order.currency ?? ORDER_CURRENCY,
  paymentIntentId,
});

const notifyPaid = async (
  order: OrderDoc,
  paymentIntentId: string | null,
): Promise<void> => {
  const vendor = await collections.users().findOne({
    _id: new ObjectId(order.vendorId),
  });
  if (!vendor) return;
  const base = paidEmailInput(order, paymentIntentId);
  try {
    await sendPaidOrderEmails({
      ...base,
      vendorEmail: vendor.email,
      vendorName: vendor.businessName?.trim() || vendor.name,
    });
  } catch (error) {
    console.error(
      "[email] Unexpected paid-order email failure:",
      error instanceof Error ? error.message : "unknown error",
    );
  }
};

const notifyFailed = async (order: OrderDoc): Promise<void> => {
  try {
    await sendPaymentFailedEmail({
      to: order.customerSnapshot.email,
      customerName: order.customerSnapshot.name,
      orderNumber: order.orderNumber,
      itemSummary: itemSummary(order),
      amount: money(order.totalAmount ?? order.totalPrice),
      currency: order.currency ?? ORDER_CURRENCY,
    });
  } catch (error) {
    console.error(
      "[email] Unexpected payment-failure email failure:",
      error instanceof Error ? error.message : "unknown error",
    );
  }
};

/** Marks an order paid only from a verified, amount-matched Stripe session. */
export const applyCustomerCheckoutSucceeded = async (
  eventId: string,
  session: Stripe.Checkout.Session,
): Promise<OrderDoc | null> => {
  if (session.payment_status !== "paid") {
    // A successful Checkout Session event must never be acknowledged while
    // Stripe still reports it unpaid. Keep the event retryable.
    throw new Error(`Customer order Checkout Session ${session.id} is not paid`);
  }
  const order = await resolveOrderFromMetadata(
    session.metadata,
    session.client_reference_id,
    session.id,
  );
  if (!order || !sessionMatchesOrder(session, order)) {
    throw new Error("Could not verify customer order Checkout Session");
  }
  const paymentIntentId = await successfulPaymentIntentId(session, order);
  if (!paymentIntentId) {
    throw new Error("Could not verify customer order PaymentIntent");
  }

  const updated = await collections.orders().findOneAndUpdate(
    {
      _id: order._id,
      paymentStatus: { $in: [null, "pending", "failed"] },
    },
    {
      $set: {
        paymentStatus: "paid",
        stripeSessionId: session.id,
        stripePaymentIntentId: paymentIntentId,
        updatedAt: new Date(),
      },
    },
    { returnDocument: "after" },
  );
  if (!updated) {
    // A paid Stripe event must never be acknowledged without settling the
    // order and its ledger. A replay after an older malformed delivery is
    // allowed to repair the ledger, but an unpaid/unmatched order is an error
    // so Stripe keeps retrying instead of the order getting stuck forever.
    const current = await collections.orders().findOne({ _id: order._id });
    if (
      !current ||
      (current.paymentStatus !== "paid" && current.paymentStatus !== "refunded")
    ) {
      throw new Error(`Could not settle customer order Checkout Session ${session.id}`);
    }

    const transaction = await collections.transactions().findOne({
      $or: [
        { orderId: current._id.toHexString() },
        { stripeEventId: eventId },
      ],
    });
    const ledgerIsCorrect =
      transaction &&
      transaction.orderId === current._id.toHexString() &&
      transaction.paymentType === "customer_order" &&
      transaction.status === current.paymentStatus;
    if (!ledgerIsCorrect) {
      await recordOrderTransaction({
        eventId,
        order: current,
        status: current.paymentStatus === "refunded" ? "refunded" : "paid",
        sessionId: session.id,
        paymentIntentId,
      });
    }
    // Cart clearing is idempotent, so a replay can finish an older delivery
    // that settled the order but stopped before clearing the cart.
    await collections.carts().updateOne(
      { _id: current.customerId },
      { $set: { items: [], updatedAt: new Date() } },
      { upsert: true },
    );
    return current;
  }

  await recordOrderTransaction({
    eventId,
    order: updated,
    status: "paid",
    sessionId: session.id,
    paymentIntentId,
  });
  await collections.carts().updateOne(
    { _id: updated.customerId },
    { $set: { items: [], updatedAt: new Date() } },
    { upsert: true },
  );
  await notifyPaid(updated, paymentIntentId);
  return updated;
};

/** Handles async/failed checkout sessions and failed payment intents. */
export const applyCustomerPaymentFailed = async (
  eventId: string,
  metadata: Stripe.Metadata | null | undefined,
  clientReferenceId: string | null | undefined,
  paymentIntentId?: string | null,
  sessionId?: string | null,
): Promise<OrderDoc | null> => {
  const order = await resolveOrderFromMetadata(metadata, clientReferenceId, sessionId);
  if (!order) return null;
  const updated = await collections.orders().findOneAndUpdate(
    {
      _id: order._id,
      paymentStatus: { $in: [null, "pending"] },
    },
    {
      $set: {
        paymentStatus: "failed",
        ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
        updatedAt: new Date(),
      },
    },
    { returnDocument: "after" },
  );
  if (!updated) return null;

  await recordOrderTransaction({
    eventId,
    order: updated,
    status: "failed",
    sessionId: updated.stripeSessionId ?? null,
    paymentIntentId: paymentIntentId ?? null,
  });
  await notifyFailed(updated);
  return updated;
};

/** Expired checkout releases the idempotency key so the customer can retry. */
export const applyCustomerCheckoutExpired = async (
  session: Stripe.Checkout.Session,
): Promise<void> => {
  const order = await resolveOrderFromMetadata(
    session.metadata,
    session.client_reference_id,
    session.id,
  );
  if (!order) return;
  await collections.orders().updateOne(
    {
      _id: order._id,
      stripeSessionId: session.id,
      paymentStatus: "pending",
    },
    {
      $set: { paymentStatus: "failed", updatedAt: new Date() },
      $unset: { checkoutIdempotencyKey: "", checkoutCartKey: "" },
    },
  );
};

const applyRefundToTransaction = async (
  transaction: TransactionDoc,
  refund: RefundRecord,
  totalRefunded: number,
  reason?: string | null,
): Promise<TransactionDoc | null> => {
  if (transaction.refunds?.some((entry) => entry.stripeRefundId === refund.stripeRefundId)) {
    return transaction;
  }
  const full = totalRefunded >= transaction.amount - 0.001;
  const status: PaymentStatus = full ? "refunded" : "paid";
  const refunds = [...(transaction.refunds ?? []), refund];
  const result = await collections.transactions().findOneAndUpdate(
    { _id: transaction._id },
    {
      $set: {
        status,
        paymentStatus: status,
        refundedAmount: money(totalRefunded),
        refunds,
        stripeEventId: refund.id,
        updatedAt: new Date(),
      },
    },
    { returnDocument: "after" },
  );
  if (!result) return null;

  if (full) {
    await collections.orders().updateOne(
      { _id: new ObjectId(result.orderId!) },
      { $set: { paymentStatus: "refunded", updatedAt: new Date() } },
    );
  }

  try {
    await sendRefundEmail({
      to: result.customerEmail ?? "",
      customerName: result.customerName ?? "Customer",
      orderNumber: result.orderId ?? "your order",
      itemSummary: result.description ?? "PizzaHub order",
      amount: refund.amount,
      currency: result.currency,
      reason: reason ?? refund.reason,
    });
  } catch (error) {
    console.error(
      "[email] Unexpected refund email failure:",
      error instanceof Error ? error.message : "unknown error",
    );
  }
  return result;
};

/** Applies a verified Stripe `charge.refunded` webhook event. */
export const applyStripeRefund = async (
  eventId: string,
  charge: Stripe.Charge,
): Promise<TransactionDoc | null> => {
  const paymentIntentId = idOf(charge.payment_intent);
  if (!paymentIntentId) return null;
  const transaction = await collections.transactions().findOne({
    stripePaymentIntentId: paymentIntentId,
  });
  if (!transaction) return null;

  const totalRefunded = money((charge.amount_refunded ?? 0) / 100);
  const stripeRefund = charge.refunds?.data?.[0];
  const amount = money((stripeRefund?.amount ?? charge.amount_refunded ?? 0) / 100);
  const refund: RefundRecord = {
    id: eventId,
    stripeRefundId: stripeRefund?.id ?? `charge_${charge.id}`,
    amount,
    currency: (charge.currency ?? transaction.currency).toUpperCase(),
    reason: stripeRefund?.reason ?? null,
    createdAt: new Date(),
  };
  return applyRefundToTransaction(transaction, refund, totalRefunded, refund.reason);
};

export interface AdminRefundInput {
  amount?: number;
  reason?: string;
}

/** Admin-controlled refund against the original Stripe PaymentIntent. */
export const refundTransactionAsAdmin = async (
  transactionId: string,
  input: AdminRefundInput,
): Promise<TransactionDoc> => {
  if (!isValidObjectId(transactionId)) throw notFound("Transaction not found");
  const transaction = await collections.transactions().findOne({
    _id: new ObjectId(transactionId),
  });
  if (!transaction) throw notFound("Transaction not found");
  if (transaction.paymentType !== "customer_order") {
    throw conflict("Only customer order payments can be refunded here");
  }
  if (transaction.paymentStatus !== "paid" && transaction.paymentStatus !== "refunded") {
    throw conflict("Only successful payments can be refunded");
  }
  const paymentIntentId = transaction.stripePaymentIntentId;
  if (!paymentIntentId) throw badRequest("This payment cannot be refunded");

  const refunded = money(transaction.refundedAmount ?? 0);
  const remaining = money(transaction.amount - refunded);
  if (remaining <= 0) throw conflict("This payment has already been fully refunded");

  const amount = input.amount === undefined ? remaining : money(input.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > remaining) {
    throw badRequest(`Refund amount must be between 0.01 and ${remaining.toFixed(2)}`);
  }

  const stripe = getStripeForPayments();
  const idempotencyKey = `pizzahub-refund-${transactionId}-${cents(amount)}`;
  const stripeRefund = await stripe.refunds.create(
    {
      payment_intent: paymentIntentId,
      amount: cents(amount),
      reason: "requested_by_customer",
      metadata: { transactionId, orderId: transaction.orderId ?? "" },
    },
    { idempotencyKey },
  );

  const totalRefunded = money(refunded + amount);
  const refund: RefundRecord = {
    id: `admin_${stripeRefund.id}`,
    stripeRefundId: stripeRefund.id,
    amount,
    currency: transaction.currency,
    reason: input.reason?.trim() || null,
    createdAt: new Date(),
  };
  const updated = await applyRefundToTransaction(
    transaction,
    refund,
    totalRefunded,
    refund.reason,
  );
  if (!updated) throw notFound("Transaction not found after refund");
  return updated;
};
