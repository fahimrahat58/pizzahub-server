import { Resend } from "resend";

import {
  env,
  getDevelopmentEmailRecipient,
  isEmailConfigured,
} from "../config/env.js";

export type EmailResult = { sent: boolean; warning?: string };

export type OrderStatusEmailInput = {
  to: string;
  customerName: string;
  orderNumber: string;
  itemName: string;
  restaurantName?: string | null;
  totalPrice: number;
  deliveryDate: string;
  status: "accepted" | "rejected";
};

export type NewOrderEmailInput = {
  vendorEmail: string;
  vendorName: string;
  customerName: string;
  customerEmail: string;
  orderNumber: string;
  itemName: string;
  restaurantName?: string | null;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  deliveryAddress: string;
  deliveryDate: string;
  message?: string | null;
};

export type NewOrderEmailResults = {
  vendor: EmailResult;
  customer: EmailResult;
};

export type PaymentEmailInput = {
  vendorEmail: string;
  vendorName: string;
  customerEmail: string;
  customerName: string;
  orderNumber: string;
  itemSummary: string;
  restaurantName?: string | null;
  amount: number;
  currency?: string | null;
  paymentIntentId?: string | null;
};

export type PaymentNoticeInput = {
  to: string;
  customerName: string;
  orderNumber: string;
  itemSummary: string;
  amount: number;
  currency?: string | null;
  reason?: string | null;
};

type OutboundEmail = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

const statusCopy = {
  accepted: {
    subject: "Your PizzaHub order was accepted",
    heading: "Good news — your order is accepted!",
    detail: "The restaurant has confirmed your pizza and will start preparing it soon.",
  },
  rejected: {
    subject: "Update on your PizzaHub order",
    heading: "Your order could not be accepted",
    detail: "The restaurant was unable to accept this order. You can place a new order at any time.",
  },
} as const;

let resendClient: Resend | null = null;

/** Resend is created lazily so an unconfigured server can still boot and serve orders. */
const getResendClient = (): Resend => {
  if (!resendClient) resendClient = new Resend(env.resendApiKey);
  return resendClient;
};

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const layout = (heading: string, paragraphs: string[]): string => `
  <div style="font-family:Inter,Arial,sans-serif;background:#fff8ef;padding:32px;color:#2b1a12;">
    <h1 style="margin:0 0 16px;color:#d9481f;font-size:24px;">${heading}</h1>
    ${paragraphs.map((paragraph) => `<p style="margin:0 0 12px;">${paragraph}</p>`).join("")}
    <p style="margin:24px 0 0;">Thanks for choosing PizzaHub.</p>
  </div>
`;

/**
 * Single Resend entry point. Every failure is converted into a result object so
 * email is always a side effect: a provider outage never rolls back an order.
 */
const sendEmail = async (
  label: string,
  email: OutboundEmail,
): Promise<EmailResult> => {
  if (!isEmailConfigured()) {
    return { sent: false, warning: "Email is not configured" };
  }

  // Only development may redirect mail to a verified test inbox. Production
  // always uses the recipient derived from the order/vendor document.
  const testRecipient = getDevelopmentEmailRecipient();
  const recipient = testRecipient ?? email.to;
  const recipientSource = testRecipient
    ? "development test recipient (RESEND_TEST_EMAIL)"
    : "original recipient";
  console.info(
    `[email] ${label}: sending to ${recipientSource} <${recipient}>${
      testRecipient ? ` instead of original recipient <${email.to}>` : ""
    }`,
  );

  try {
    const { data, error } = await getResendClient().emails.send(
      {
        from: env.emailFrom,
        to: [recipient],
        subject: email.subject,
        html: email.html,
        text: email.text,
      },
      { signal: AbortSignal.timeout(10_000) },
    );

    if (error) {
      const status = error.statusCode ?? "unknown";
      console.error(
        `[email] Resend rejected ${label} email for ${recipientSource} <${recipient}> (${status}): ${error.message}`,
      );
      return { sent: false, warning: "Email provider rejected the message" };
    }

    if (!data?.id) {
      console.error(
        `[email] Resend returned no message id for ${label} email to ${recipientSource} <${recipient}>`,
      );
      return { sent: false, warning: "Email provider returned no confirmation" };
    }

    console.info(
      `[email] ${label}: delivered to ${recipientSource} <${recipient}> (message ${data.id})`,
    );
    return { sent: true };
  } catch (caught) {
    console.error(
      `[email] Failed to send ${label} email to ${recipientSource} <${recipient}>:`,
      caught instanceof Error ? caught.message : "unknown error",
    );
    return { sent: false, warning: "Email provider unavailable" };
  }
};

/** Notifies the vendor and confirms the customer after an order is persisted. */
export const sendNewOrderEmails = async (
  input: NewOrderEmailInput,
): Promise<NewOrderEmailResults> => {
  const restaurant = input.restaurantName
    ? ` from ${escapeHtml(input.restaurantName)}`
    : "";
  const restaurantText = input.restaurantName
    ? ` from ${input.restaurantName}`
    : "";
  const orderSummary = `Order <strong>${escapeHtml(input.orderNumber)}</strong> · ${input.quantity} × ${escapeHtml(input.itemName)} · Total $${input.totalPrice.toFixed(2)}`;
  const orderSummaryText = `Order ${input.orderNumber} · ${input.quantity} × ${input.itemName} · Total $${input.totalPrice.toFixed(2)}`;
  const delivery = `Delivery <strong>${escapeHtml(input.deliveryDate)}</strong> to ${escapeHtml(input.deliveryAddress)}`;
  const deliveryText = `Delivery ${input.deliveryDate} to ${input.deliveryAddress}`;
  const note = input.message?.trim()
    ? `<p style="margin:0 0 12px;"><em>Note: ${escapeHtml(input.message.trim())}</em></p>`
    : "";
  const noteText = input.message?.trim()
    ? `Note: ${input.message.trim()}`
    : null;

  const vendorHtml = layout("New order received", [
    `Hi ${escapeHtml(input.vendorName)},`,
    `A customer placed a new order${restaurant}.`,
    orderSummary,
    `Customer: ${escapeHtml(input.customerName)} (${escapeHtml(input.customerEmail)})`,
    delivery,
    ...(note ? [note] : []),
  ]);
  const vendorText = [
    "New order received",
    `Hi ${input.vendorName},`,
    `A customer placed a new order${restaurantText}.`,
    orderSummaryText,
    `Customer: ${input.customerName} (${input.customerEmail})`,
    deliveryText,
    noteText,
    "Sign in to your vendor dashboard to accept or reject it.",
    "Thanks for choosing PizzaHub.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const customerHtml = layout("Thanks for your order!", [
    `Hi ${escapeHtml(input.customerName)},`,
    `We received your order${restaurant} and sent it to the kitchen for review.`,
    orderSummary,
    delivery,
    "We'll email you again when the restaurant accepts or rejects your order.",
    ...(note ? [note] : []),
  ]);
  const customerText = [
    "Thanks for your order!",
    `Hi ${input.customerName},`,
    `We received your order${restaurantText} and sent it to the kitchen for review.`,
    orderSummaryText,
    deliveryText,
    "We'll email you again when the restaurant accepts or rejects your order.",
    noteText,
    "Thanks for choosing PizzaHub.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const [vendor, customer] = await Promise.all([
    sendEmail("new-order vendor", {
      to: input.vendorEmail,
      subject: `New PizzaHub order ${input.orderNumber}`,
      html: vendorHtml,
      text: vendorText,
    }),
    sendEmail("new-order customer", {
      to: input.customerEmail,
      subject: `Your PizzaHub order ${input.orderNumber} is confirmed`,
      html: customerHtml,
      text: customerText,
    }),
  ]);

  return { vendor, customer };
};

/** Sends an accepted/rejected status update to the customer. */
export const sendOrderStatusEmail = async (
  input: OrderStatusEmailInput,
): Promise<EmailResult> => {
  if (!isEmailConfigured()) {
    return { sent: false, warning: "Email is not configured" };
  }

  const copy = statusCopy[input.status];
  const restaurant = input.restaurantName
    ? ` from ${escapeHtml(input.restaurantName)}`
    : "";
  const restaurantText = input.restaurantName
    ? ` from ${input.restaurantName}`
    : "";
  const html = layout(copy.heading, [
    `Hi ${escapeHtml(input.customerName)},`,
    copy.detail,
    `<strong>${escapeHtml(input.itemName)}</strong>${restaurant}`,
    `Order <strong>${escapeHtml(input.orderNumber)}</strong> · Delivery ${escapeHtml(input.deliveryDate)} · Total $${input.totalPrice.toFixed(2)}`,
  ]);
  const text = [
    copy.heading,
    `Hi ${input.customerName},`,
    copy.detail,
    `${input.itemName}${restaurantText}`,
    `Order ${input.orderNumber} · Delivery ${input.deliveryDate} · Total $${input.totalPrice.toFixed(2)}`,
    "Thanks for choosing PizzaHub.",
  ].join("\n\n");

  return sendEmail(`${input.status} status`, {
    to: input.to,
    subject: copy.subject,
    html,
    text,
  });
};

const paymentAmount = (amount: number, currency?: string | null): string => {
  const code = currency?.toUpperCase() ?? "USD";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
    }).format(amount);
  } catch {
    return `${code} ${amount.toFixed(2)}`;
  }
};

/**
 * Sent only after a verified Stripe webhook marks the order paid. No payment
 * email is sent from the success page or from checkout creation.
 */
export const sendPaidOrderEmails = async (
  input: PaymentEmailInput,
): Promise<NewOrderEmailResults> => {
  const total = paymentAmount(input.amount, input.currency);
  const restaurant = input.restaurantName
    ? ` from ${escapeHtml(input.restaurantName)}`
    : "";
  const restaurantText = input.restaurantName
    ? ` from ${input.restaurantName}`
    : "";
  const reference = input.paymentIntentId
    ? ` Payment reference: ${escapeHtml(input.paymentIntentId)}.`
    : "";

  const [vendor, customer] = await Promise.all([
    sendEmail("paid-order vendor", {
      to: input.vendorEmail,
      subject: `PizzaHub order ${input.orderNumber} paid`,
      html: layout("Order paid", [
        `Hi ${escapeHtml(input.vendorName)},`,
        `Payment was received for order <strong>${escapeHtml(input.orderNumber)}</strong>${restaurant}.`,
        `${escapeHtml(input.itemSummary)} · Total ${escapeHtml(total)}`,
        `Customer: ${escapeHtml(input.customerName)} (${escapeHtml(input.customerEmail)})`,
        "The order now follows the normal restaurant workflow.",
      ]),
      text: [
        "Order paid",
        `Hi ${input.vendorName},`,
        `Payment was received for order ${input.orderNumber}${restaurantText}.`,
        `${input.itemSummary} · Total ${total}`,
        `Customer: ${input.customerName} (${input.customerEmail})`,
        "The order now follows the normal restaurant workflow.",
        "Thanks for choosing PizzaHub.",
      ].join("\n"),
    }),
    sendEmail("paid-order customer", {
      to: input.customerEmail,
      subject: `Payment received for PizzaHub order ${input.orderNumber}`,
      html: layout("Payment received", [
        `Hi ${escapeHtml(input.customerName)},`,
        `We received your ${escapeHtml(total)} payment for order <strong>${escapeHtml(input.orderNumber)}</strong>${restaurant}.`,
        escapeHtml(input.itemSummary),
        `${reference}`,
        "We'll email you when the restaurant accepts your order.",
      ]),
      text: [
        "Payment received",
        `Hi ${input.customerName},`,
        `We received your ${total} payment for order ${input.orderNumber}${restaurantText}.`,
        input.itemSummary,
        reference.trim(),
        "We'll email you when the restaurant accepts your order.",
        "Thanks for choosing PizzaHub.",
      ]
        .filter(Boolean)
        .join("\n"),
    }),
  ]);

  return { vendor, customer };
};

/** Notifies the customer after a verified payment failure event. */
export const sendPaymentFailedEmail = async (
  input: PaymentNoticeInput,
): Promise<EmailResult> => {
  const total = paymentAmount(input.amount, input.currency);
  return sendEmail("payment failed", {
    to: input.to,
    subject: `Payment failed for PizzaHub order ${input.orderNumber}`,
    html: layout("Payment failed", [
      `Hi ${escapeHtml(input.customerName)},`,
      `We could not complete your ${escapeHtml(total)} payment for order <strong>${escapeHtml(input.orderNumber)}</strong>.`,
      escapeHtml(input.itemSummary),
      "No order has been confirmed. You can start a new checkout to try again.",
    ]),
    text: [
      "Payment failed",
      `Hi ${input.customerName},`,
      `We could not complete your ${total} payment for order ${input.orderNumber}.`,
      input.itemSummary,
      "No order has been confirmed. You can start a new checkout to try again.",
    ].join("\n"),
  });
};

/** Notifies the customer after a verified Stripe refund. */
export const sendRefundEmail = async (
  input: PaymentNoticeInput,
): Promise<EmailResult> => {
  const total = paymentAmount(input.amount, input.currency);
  return sendEmail("payment refunded", {
    to: input.to,
    subject: `Refund issued for PizzaHub order ${input.orderNumber}`,
    html: layout("Refund issued", [
      `Hi ${escapeHtml(input.customerName)},`,
      `A refund of ${escapeHtml(total)} was issued for order <strong>${escapeHtml(input.orderNumber)}</strong>.`,
      escapeHtml(input.itemSummary),
      ...(input.reason ? [`Reason: ${escapeHtml(input.reason)}`] : []),
      "Depending on your bank, the refund can take several business days to appear.",
    ]),
    text: [
      "Refund issued",
      `Hi ${input.customerName},`,
      `A refund of ${total} was issued for order ${input.orderNumber}.`,
      input.itemSummary,
      ...(input.reason ? [`Reason: ${input.reason}`] : []),
      "Depending on your bank, the refund can take several business days to appear.",
    ].join("\n"),
  });
};
