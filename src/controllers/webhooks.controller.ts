import type { Request, Response } from "express";
import type Stripe from "stripe";

import { env, isStripeConfigured } from "../config/env.js";
import { getStripe } from "../config/stripe.js";
import {
  claimStripeEvent,
  completeStripeEvent,
  getEffectiveSubscription,
  recordSubscriptionEvent,
  recordTransaction,
  releaseStripeEvent,
  syncCheckoutSession,
  syncSubscription,
  type SubscriptionSyncInput,
} from "../services/subscription.service.js";
import { asyncHandler } from "../utils/errors.js";
import type {
  BillingPlanId,
  SubscriptionPlan,
  SubscriptionStatus,
} from "../types/models.js";

const idOf = (
  value: string | { id: string } | null | undefined,
): string | null => {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
};

const eventSecondsOf = (event: Stripe.Event): number =>
  typeof event.created === "number" && Number.isFinite(event.created)
    ? event.created
    : Math.floor(Date.now() / 1000);

const billingPlanIdOf = (value: string | undefined): BillingPlanId | null =>
  value === "monthly" || value === "yearly" ? value : null;

const eventStatus = (status: SubscriptionStatus | "none"): SubscriptionStatus | null =>
  status === "none" ? null : status;

const subscriptionInput = (
  snapshot: Stripe.Subscription,
  options: Pick<SubscriptionSyncInput, "eventId" | "eventCreated"> &
    Partial<SubscriptionSyncInput>,
): SubscriptionSyncInput => ({
  id: snapshot.id,
  customer: snapshot.customer,
  status: snapshot.status,
  metadata: snapshot.metadata,
  cancel_at_period_end: snapshot.cancel_at_period_end,
  items: snapshot.items,
  ...options,
});

const resolveSubscription = async (
  stripe: Stripe,
  value: string | Stripe.Subscription | null | undefined,
): Promise<Stripe.Subscription | null> => {
  if (!value) return null;
  return typeof value === "string" ? stripe.subscriptions.retrieve(value) : value;
};

/**
 * Applies a verified Stripe event. Every database write here originates from
 * Stripe, never from a browser request.
 */
const applyEvent = async (event: Stripe.Event): Promise<void> => {
  const stripe = getStripe();
  const eventId = event.id;
  const eventCreated = eventSecondsOf(event);
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
      description = "Checkout completed";
      amount = (session.amount_total ?? 0) / 100;
      currency = session.currency ?? "usd";

      // Linking the session never activates Premium. It only records which
      // verified Checkout Session the vendor used.
      let vendor = await syncCheckoutSession({
        eventId,
        eventCreated,
        sessionId: session.id,
        customerId: idOf(session.customer),
        vendorId: session.metadata?.vendorId ?? session.client_reference_id ?? null,
        plan: billingPlanIdOf(session.metadata?.plan),
      });

      const snapshot = await resolveSubscription(stripe, session.subscription);
      if (snapshot) {
        paymentSubscriptionId = snapshot.id;
        const synced = await syncSubscription(
          subscriptionInput(snapshot, {
            eventId,
            eventCreated,
            checkoutSessionId: session.id,
          }),
        );
        if (synced) vendor = synced;
      }

      if (!snapshot) {
        // No subscription snapshot yet: record the verified payment only.
        // This must not be derived from the current plan, which may still be
        // Free while Stripe finishes creating the subscription.
        plan = "premium";
        status = "incomplete";
      }

      if (vendor) {
        vendorId = vendor._id.toHexString();
        if (snapshot) {
          const effective = getEffectiveSubscription(vendor);
          plan = effective.plan;
          status = eventStatus(effective.status);
        }
      }
      break;
    }

    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const user = await syncSubscription(
        subscriptionInput(event.data.object, { eventId, eventCreated }),
      );
      description = `Subscription ${event.type.split(".").pop()}`;
      if (user) {
        vendorId = user._id.toHexString();
        const effective = getEffectiveSubscription(user);
        plan = effective.plan;
        status = eventStatus(effective.status);
      }
      break;
    }

    case "invoice.paid":
    case "invoice.payment_succeeded":
    case "invoice.payment_failed": {
      const invoice = event.data.object;
      const succeeded = event.type !== "invoice.payment_failed";
      description = succeeded ? "Renewal payment succeeded" : "Renewal payment failed";
      amount = ((succeeded ? invoice.amount_paid : invoice.amount_due) ?? 0) / 100;
      currency = invoice.currency ?? "usd";
      status = succeeded ? "active" : "past_due";

      const parentSubscription =
        invoice.parent?.subscription_details?.subscription ?? null;
      paymentSubscriptionId = idOf(parentSubscription);
      const snapshot = await resolveSubscription(stripe, parentSubscription);
      if (snapshot) {
        paymentSubscriptionId = snapshot.id;
        const user = await syncSubscription(
          subscriptionInput(snapshot, { eventId, eventCreated }),
        );
        if (user) {
          vendorId = user._id.toHexString();
          const effective = getEffectiveSubscription(user);
          plan = effective.plan;
          if (succeeded) status = eventStatus(effective.status);
        }
      }
      break;
    }

    default:
      // Unhandled events are still claimed so retries do not repeat work.
      console.log("Stripe webhook event type not handled", {
        eventId,
        eventType: event.type,
      });
      return;
  }

  if (vendorId) {
    await recordSubscriptionEvent({
      eventId,
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
      eventId,
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
  const signature = req.headers["stripe-signature"];
  console.log("Stripe webhook request received", {
    method: req.method,
    path: req.originalUrl,
    signaturePresent: typeof signature === "string" && signature.length > 0,
    contentType: req.headers["content-type"] ?? null,
    bodyBytes: Buffer.isBuffer(req.body) ? req.body.length : null,
  });

  if (!isStripeConfigured()) {
    res.status(503).json({ success: false, message: "Billing is not configured" });
    return;
  }

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

  console.log("Stripe webhook signature verified", {
    eventId: event.id,
    eventType: event.type,
    livemode: event.livemode,
  });

  const claim = await claimStripeEvent(event.id, event.type);
  if (claim === "duplicate") {
    console.log("Stripe webhook duplicate ignored", {
      eventId: event.id,
      eventType: event.type,
    });
    res.json({ received: true, duplicate: true });
    return;
  }

  try {
    await applyEvent(event);
    await completeStripeEvent(event.id);
    console.log("Stripe webhook processed", {
      eventId: event.id,
      eventType: event.type,
    });
    res.json({ received: true });
  } catch (error) {
    // Release the claim so Stripe's automatic retry can process the event.
    // A cleanup failure must not leave the client without a response.
    try {
      await releaseStripeEvent(event.id);
    } catch (releaseError) {
      console.error("Could not release Stripe event claim:", releaseError);
    }
    console.error("Stripe webhook processing failed:", error);
    res.status(500).json({ success: false, message: "Webhook processing failed" });
  }
});
