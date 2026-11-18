import { env, isEmailConfigured } from "../config/env.js";

type OrderEmailInput = {
  to: string;
  customerName: string;
  orderNumber: string;
  itemName: string;
  restaurantName?: string | null;
  totalPrice: number;
  deliveryDate: string;
  status: "accepted" | "rejected";
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

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/**
 * Sends order status email through Resend's REST API. Email is a side effect:
 * a provider failure must never roll back a completed order transition.
 */
export const sendOrderStatusEmail = async (
  input: OrderEmailInput,
): Promise<{ sent: boolean; warning?: string }> => {
  if (!isEmailConfigured()) {
    return { sent: false, warning: "Email is not configured" };
  }

  const copy = statusCopy[input.status];
  const restaurant = input.restaurantName
    ? ` from ${escapeHtml(input.restaurantName)}`
    : "";
  const html = `
    <div style="font-family:Inter,Arial,sans-serif;background:#fff8ef;padding:32px;color:#2b1a12;">
      <h1 style="margin:0 0 16px;color:#d9481f;font-size:24px;">${copy.heading}</h1>
      <p style="margin:0 0 12px;">Hi ${escapeHtml(input.customerName)},</p>
      <p style="margin:0 0 12px;">${copy.detail}</p>
      <p style="margin:0 0 12px;"><strong>${escapeHtml(input.itemName)}</strong>${restaurant}</p>
      <p style="margin:0 0 12px;">Order <strong>${escapeHtml(input.orderNumber)}</strong> · Delivery ${escapeHtml(input.deliveryDate)} · Total $${input.totalPrice.toFixed(2)}</p>
      <p style="margin:24px 0 0;">Thanks for choosing PizzaHub.</p>
    </div>
  `;
  const text = `${copy.heading}\n\nHi ${input.customerName},\n${copy.detail}\n${input.itemName}${restaurant ? ` from ${input.restaurantName}` : ""}\nOrder ${input.orderNumber} · Delivery ${input.deliveryDate} · Total $${input.totalPrice.toFixed(2)}\n\nThanks for choosing PizzaHub.`;

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.emailFrom,
        to: [input.to],
        subject: copy.subject,
        html,
        text,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      console.error(`[email] Resend rejected ${input.status} email: ${response.status} ${detail}`);
      return { sent: false, warning: "Email provider rejected the message" };
    }
    return { sent: true };
  } catch (error) {
    console.error(
      `[email] Failed to send ${input.status} email:`,
      error instanceof Error ? error.message : "unknown error",
    );
    return { sent: false, warning: "Email provider unavailable" };
  }
};
