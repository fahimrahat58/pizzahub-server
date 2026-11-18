import type { Request, Response } from "express";
import type Stripe from "stripe";

import { env, isStripeConfigured } from "../config/env.js";
import { getStripe } from "../config/stripe.js";
import {
  claimStripeEvent,
  completeStripeEvent,
  getEffectiveSubscription,
  normalizeStripeStatus,
  recordSubscriptionEvent,
  recordTransaction,
  releaseStripeEvent,
  syncSubscription,
} from "../services/subscription.service.js";
import { asyncHandler } from "../utils/errors.js";
import type { SubscriptionPlan, SubscriptionStatus } from "../types/models.js";

const subscriptionIdOf = (
  value: string | Stripe.Subscription | null | undefined,
): string | null => {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
};

const eventStatus = (status: SubscriptionStatus | "none"): SubscriptionStatus | null =>
  status === "none" ? null : status;

/**
 * Applies a verified Stripe event. Every database write here originates from
 * Stripe, never from a browser request.
 */
const applyEvent = async (event: Stripe.Event): Promise<void> => {
  const stripe = getStripe();
  let vendorId: string | null = null;
  let plan: SubscriptionPlan | null = null;
  let status: SubscriptionStatus | null = null;
  let description: string | null = null;
  let amount: number | null = null;
  let currency = "usd";
  let paymentSubscriptionId: string | null = null;

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      vendorId = session.metadata?.vendorId ?? session.client_reference_id ?? null;
      description = "Checkout completed";
      const subscriptionId = subscriptionIdOf(session.subscription);
      // Stripe reports monetary amounts in the smallest currency unit.
      amount = (session.amount_total ?? 0) / 100;
      currency = session.currency ?? "usd";
      paymentSubscriptionId = subscriptionId;

      if (subscriptionId) {
        // Retrieve the subscription so we store Stripe's authoritative status.
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const user = await syncSubscription(subscription);
        if (user) {
          vendorId = user._id.toHexString();
          const effective = getEffectiveSubscription(user);
          plan = effective.plan;
          status = eventStatus(effective.status);
        }
      } else {
        // A completed checkout with no subscription yet still represents a
        // verified payment. Record it as an incomplete Premium transaction;
        // the following subscription event finalises the plan state.
        plan = "premium";
        status = "incomplete";
      }
      break;
    }

    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const subscription = event.data.object;
      vendorId = subscription.metadata?.vendorId ?? null;
      description = `Subscription ${event.type.split(".").pop()}`;
      const user = await syncSubscription(subscription);
      if (user) {
        vendorId = user._id.toHexString();
        const effective = getEffectiveSubscription(user);
        plan = effective.plan;
        status = eventStatus(effective.status);
      }
      break;
    }

    case "invoice.payment_succeeded":
    case "invoice.payment_failed": {
      const invoice = event.data.object;
      const succeeded = event.type === "invoice.payment_succeeded";
      description = succeeded ? "Renewal payment succeeded" : "Renewal payment failed";
      status = succeeded ? "active" : "past_due";
      amount = ((succeeded ? invoice.amount_paid : invoice.amount_due) ?? 0) / 100;
      currency = invoice.currency ?? "usd";

      const subscriptionId = subscriptionIdOf(
        invoice.parent?.subscription_details?.subscription,
      );
      paymentSubscriptionId = subscriptionId;
      if (subscriptionId) {
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const user = await syncSubscription(subscription);
        if (user) {
          vendorId = user._id.toHexString();
          const effective = getEffectiveSubscription(user);
          plan = effective.plan;
          status = normalizeStripeStatus(subscription.status);
        }
      }
      break;
    }

    default:
      // Unhandled events are still claimed so retries do not repeat work.
      return;
  }

  if (vendorId) {
    await recordSubscriptionEvent({
      eventId: event.id,
      type: event.type,
      vendorId,
      plan,
      status,
      description,
    });
  }

  // Only payment events produce a transaction record; subscription lifecycle
  // events without an amount are tracked in subscriptionEvents above.
  if (vendorId && amount !== null && status) {
    await recordTransaction({
      eventId: event.id,
      vendorId,
      plan,
      amount,
      currency,
      status,
      subscriptionId: paymentSubscriptionId,
      description,
    });
  }
};

/**
 * Registered before express.json() so `req.body` remains the original bytes
 * required by Stripe's signature verification.
 */
export const stripeWebhook = asyncHandler(async (req: Request, res: Response) => {
  if (!isStripeConfigured()) {
    res.status(503).json({ success: false, message: "Billing is not configured" });
    return;
  }

  const signature = req.headers["stripe-signature"];
  if (typeof signature !== "string" || signature.length === 0) {
    res.status(400).json({ success: false, message: "Missing Stripe signature" });
    return;
  }
  if (!Buffer.isBuffer(req.body)) {
    res.status(400).json({ success: false, message: "Raw webhook body required" });
    return;
  }

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(
      req.body,
      signature,
      env.stripeWebhookSecret,
    );
  } catch {
    // Never log the payload or secret here.
    console.warn("Rejected Stripe webhook with an invalid signature");
    res.status(400).json({ success: false, message: "Invalid Stripe signature" });
    return;
  }

  const claim = await claimStripeEvent(event.id, event.type);
  if (claim === "duplicate") {
    res.json({ received: true, duplicate: true });
    return;
  }

  try {
    await applyEvent(event);
    await completeStripeEvent(event.id);
    res.json({ received: true });
  } catch (error) {
    // Release the claim so Stripe's automatic retry can process the event.
    await releaseStripeEvent(event.id);
    console.error("Stripe webhook processing failed:", error);
    res.status(500).json({ success: false, message: "Webhook processing failed" });
  }
});
