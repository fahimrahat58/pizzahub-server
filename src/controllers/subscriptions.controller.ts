import type { Request, Response } from "express";
import { ObjectId } from "mongodb";
import type Stripe from "stripe";
import { z } from "zod";

import { collections } from "../config/database.js";
import { env, isStripeConfigured, stripeConfigIssue } from "../config/env.js";
import { getPriceId, getStripe, type BillingPlan } from "../config/stripe.js";
import {
  ApiError,
  asyncHandler,
  badRequest,
  conflict,
  notFound,
} from "../utils/errors.js";
import {
  acquireCheckoutLock,
  getEffectiveSubscription,
  markCheckoutLockSession,
  releaseCheckoutLock,
  syncSubscription,
} from "../services/subscription.service.js";

/** Only a plan choice is accepted from the client. No Price IDs or amounts. */
export const checkoutSchema = z
  .object({ plan: z.enum(["monthly", "yearly"]) })
  .strict();

const frontendOrigin = (): string =>
  env.frontendUrl.split(",")[0]!.trim().replace(/\/$/, "");

const requireStripe = () => {
  if (!isStripeConfigured()) {
    throw new ApiError(503, stripeConfigIssue() ?? "Stripe is not configured");
  }
  return getStripe();
};

const vendorFilter = (id: string) => ({
  _id: new ObjectId(id),
  role: "vendor" as const,
});

const expectedInterval: Record<BillingPlan, "month" | "year"> = {
  monthly: "month",
  yearly: "year",
};

/** Rejects a misconfigured Price before a Checkout Session can be created. */
const assertConfiguredPrice = async (stripe: Stripe, plan: BillingPlan) => {
  const priceId = getPriceId(plan);
  const price = await stripe.prices.retrieve(priceId);
  const actualInterval = price.recurring?.interval ?? null;
  const actualCount = price.recurring?.interval_count ?? null;

  console.info("Stripe checkout price validation", {
    selectedPlan: plan,
    selectedInterval: expectedInterval[plan],
    requestedPriceId: priceId,
    actualPriceId: price.id,
    actualInterval,
    actualIntervalCount: actualCount,
    active: price.active,
    livemode: price.livemode,
  });

  if (
    !price.active ||
    actualInterval !== expectedInterval[plan] ||
    actualCount !== 1
  ) {
    throw new ApiError(
      503,
      `Stripe ${plan} Price is misconfigured: expected a 1 ${expectedInterval[plan]} recurring interval.`,
    );
  }
  return price;
};

/** Maps a live Stripe snapshot into the trusted webhook sync input. */
const subscriptionSyncInput = (
  subscription: Stripe.Subscription,
  preserveEventMetadata = false,
) => ({
  id: subscription.id,
  customer: subscription.customer,
  status: subscription.status,
  metadata: subscription.metadata,
  cancel_at: subscription.cancel_at,
  cancel_at_period_end: subscription.cancel_at_period_end,
  canceled_at: subscription.canceled_at,
  ended_at: subscription.ended_at,
  items: subscription.items,
  preserveEventMetadata,
});

export const getPlans = asyncHandler(async (_req: Request, res: Response) => {
  const plans = [
    {
      id: "free",
      name: "Free",
      interval: null,
      amount: 0,
      currency: "usd",
    },
    {
      id: "monthly",
      name: "Premium Monthly",
      interval: "month",
      amount: null as number | null,
      currency: "usd",
    },
    {
      id: "yearly",
      name: "Premium Yearly",
      interval: "year",
      amount: null as number | null,
      currency: "usd",
    },
  ];

  let configured = isStripeConfigured();
  let issue: string | null = null;

  if (configured) {
    try {
      const stripe = getStripe();
      const [monthly, yearly] = await Promise.all([
        stripe.prices.retrieve(getPriceId("monthly")),
        stripe.prices.retrieve(getPriceId("yearly")),
      ]);
      plans[1]!.amount = monthly.unit_amount;
      plans[1]!.currency = monthly.currency;
      plans[1]!.interval = monthly.recurring?.interval ?? "month";
      plans[2]!.amount = yearly.unit_amount;
      plans[2]!.currency = yearly.currency;
      plans[2]!.interval = yearly.recurring?.interval ?? "year";
    } catch {
      configured = false;
      issue = "Stripe prices could not be loaded. Confirm the Price IDs in the server environment.";
    }
  } else {
    issue = stripeConfigIssue();
  }

  res.json({ success: true, configured, issue, plans });
});

export const getSubscriptionStatus = asyncHandler(
  async (req: Request, res: Response) => {
    let user = await collections.users().findOne(vendorFilter(req.user!.id));
    if (!user) throw notFound("Vendor not found");
    let stripeRecurringInterval: "month" | "year" | null = null;

    // Portal cancellations can happen moments before this request. Reconcile
    // from the authenticated vendor's own Stripe subscription so the UI does
    // not have to wait for a webhook retry. Stripe API failures never erase
    // the stored state; the webhook remains the durable source of truth.
    if (isStripeConfigured() && user.stripeCustomerId && user.stripeSubscriptionId) {
      try {
        const stripe = getStripe();
        const live = await stripe.subscriptions.retrieve(user.stripeSubscriptionId, {
          expand: ["items.data.price"],
        });
        const liveCustomerId =
          typeof live.customer === "string" ? live.customer : live.customer.id;

        if (liveCustomerId === user.stripeCustomerId) {
          const liveInterval = live.items.data
            .map((item) => item.price?.recurring?.interval)
            .find(
              (interval): interval is "month" | "year" =>
                interval === "month" || interval === "year",
            );
          stripeRecurringInterval = liveInterval ?? null;

          const synced = await syncSubscription(subscriptionSyncInput(live, true));
          if (synced) user = synced;
        } else {
          console.warn("Subscription status reconciliation rejected a customer mismatch", {
            vendorId: user._id.toHexString(),
            subscriptionId: live.id,
          });
        }
      } catch (error) {
        console.warn("Stripe subscription reconciliation was unavailable", {
          vendorId: user._id.toHexString(),
          subscriptionId: user.stripeSubscriptionId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const effective = getEffectiveSubscription(user);
    const purchasedInterval = stripeRecurringInterval ?? user.billingInterval ?? null;

    // Webhook confirmation can arrive while the success page is open; never
    // let an intermediary cache the result that page polls.
    res.set("Cache-Control", "no-store");
    res.json({
      success: true,
      subscription: {
        plan: effective.plan,
        status: effective.status,
        isPremium: effective.isPremium,
        activeItemLimit: effective.activeItemLimit,
        activeRestaurantLimit: effective.activeRestaurantLimit,
        billingPlanId:
          purchasedInterval === "month"
            ? "monthly"
            : purchasedInterval === "year"
              ? "yearly"
              : user.billingPlanId ?? null,
        // The purchased cycle is Stripe-derived, never the frontend toggle.
        billingInterval: purchasedInterval,
        stripeRecurringInterval,
        stripeCustomerId: user.stripeCustomerId ?? null,
        stripeSubscriptionId: user.stripeSubscriptionId ?? null,
        stripeCheckoutSessionId: user.stripeCheckoutSessionId ?? null,
        stripePriceId: user.stripePriceId ?? null,
        currentPeriodStart: user.currentPeriodStart ?? null,
        currentPeriodEnd: user.currentPeriodEnd ?? effective.expiresAt,
        subscriptionExpiresAt: effective.expiresAt,
        cancelAt: user.cancelAt ?? null,
        cancelAtPeriodEnd: effective.cancelAtPeriodEnd,
        endedAt: user.endedAt ?? null,
        canceledAt: effective.canceledAt,
        hasBillingAccount: Boolean(user.stripeCustomerId),
      },
    });
  },
);

export const createCheckoutSession = asyncHandler(
  async (req: Request, res: Response) => {
    const { plan }: { plan: BillingPlan } = checkoutSchema.parse(req.body);
    const stripe = requireStripe();

    const user = await collections.users().findOne(vendorFilter(req.user!.id));
    if (!user) throw notFound("Vendor not found");

    const price = await assertConfiguredPrice(stripe, plan);
    const effective = getEffectiveSubscription(user);
    if (user.stripeSubscriptionId && effective.isPremium) {
      throw conflict(
        "You already have an active Premium subscription. Use Manage Subscription to change or cancel it.",
      );
    }

    const vendorId = user._id.toHexString();
    const acquired = await acquireCheckoutLock(vendorId, plan);
    if (!acquired) {
      throw conflict(
        "A checkout is already in progress. Finish or abandon it before starting another one.",
      );
    }

    let sessionCreated = false;
    try {
      let customerId = user.stripeCustomerId ?? null;
      if (customerId) {
        try {
          const existing = await stripe.customers.retrieve(customerId);
          if (existing.deleted) customerId = null;
        } catch {
          customerId = null;
        }
      }

      if (!customerId) {
        const customer = await stripe.customers.create({
          name: user.name,
          email: user.email,
          metadata: { vendorId, userId: vendorId },
        });
        customerId = customer.id;
        await collections.users().updateOne(
          { _id: user._id },
          { $set: { stripeCustomerId: customerId, updatedAt: new Date() } },
        );
      }

      // Stripe is authoritative: stale MongoDB subscription fields never block
      // a legitimate new purchase, but a live Stripe subscription does.
      const [active, trialing] = await Promise.all([
        stripe.subscriptions.list({ customer: customerId, status: "active", limit: 10 }),
        stripe.subscriptions.list({ customer: customerId, status: "trialing", limit: 10 }),
      ]);
      if (active.data.length > 0 || trialing.data.length > 0) {
        throw conflict(
          "An active subscription already exists for this billing account. Manage it from the billing portal.",
        );
      }

      const origin = frontendOrigin();
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: customerId,
        line_items: [{ price: price.id, quantity: 1 }],
        client_reference_id: vendorId,
        metadata: { vendorId, plan },
        subscription_data: { metadata: { vendorId, plan } },
        allow_promotion_codes: true,
        success_url: `${origin}/dashboard/vendor/subscription/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/dashboard/vendor/subscription/cancel`,
      });

      if (!session.url) {
        throw new ApiError(502, "Stripe did not return a checkout URL");
      }

      sessionCreated = true;
      await markCheckoutLockSession(vendorId, session.id);
      const createdSubscriptionId =
        typeof session.subscription === "string"
          ? session.subscription
          : session.subscription?.id ?? null;
      console.info("Stripe checkout session created", {
        vendorId,
        selectedPlan: plan,
        selectedInterval: expectedInterval[plan],
        requestedPriceId: price.id,
        actualPriceId: price.id,
        recurringInterval: price.recurring?.interval ?? null,
        customerId,
        sessionId: session.id,
        subscriptionId: createdSubscriptionId,
      });

      res.json({ success: true, url: session.url, sessionId: session.id });
    } catch (error) {
      if (!sessionCreated) await releaseCheckoutLock(vendorId);
      throw error;
    }
  },
);

export const createPortalSession = asyncHandler(
  async (req: Request, res: Response) => {
    const stripe = requireStripe();
    const user = await collections.users().findOne(vendorFilter(req.user!.id));
    if (!user) throw notFound("Vendor not found");
    if (!user.stripeCustomerId) {
      throw badRequest("No billing account yet. Subscribe to Premium first.");
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${frontendOrigin()}/dashboard/vendor/subscription`,
    });

    res.json({ success: true, url: session.url });
  },
);
