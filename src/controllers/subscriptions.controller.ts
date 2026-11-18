import type { Request, Response } from "express";
import { ObjectId } from "mongodb";
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
import { getEffectiveSubscription } from "../services/subscription.service.js";

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
      plans[2]!.amount = yearly.unit_amount;
      plans[2]!.currency = yearly.currency;
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
    const user = await collections.users().findOne(vendorFilter(req.user!.id));
    if (!user) throw notFound("Vendor not found");

    const effective = getEffectiveSubscription(user);

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
        billingPlanId: user.billingPlanId ?? null,
        stripeCustomerId: user.stripeCustomerId ?? null,
        stripeSubscriptionId: user.stripeSubscriptionId ?? null,
        stripeCheckoutSessionId: user.stripeCheckoutSessionId ?? null,
        stripePriceId: user.stripePriceId ?? null,
        subscriptionExpiresAt: effective.expiresAt,
        cancelAtPeriodEnd: effective.cancelAtPeriodEnd,
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

    const effective = getEffectiveSubscription(user);
    if (user.stripeSubscriptionId && effective.isPremium) {
      throw conflict(
        "You already have an active Premium subscription. Use Manage Subscription to change or cancel it.",
      );
    }

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
        metadata: {
          vendorId: user._id.toHexString(),
          userId: user._id.toHexString(),
        },
      });
      customerId = customer.id;
      await collections.users().updateOne(
        { _id: user._id },
        { $set: { stripeCustomerId: customerId, updatedAt: new Date() } },
      );
    }

    // Belt-and-braces duplicate protection: Stripe is authoritative even if
    // a previous webhook was missed.
    const [active, trialing] = await Promise.all([
      stripe.subscriptions.list({ customer: customerId, status: "active", limit: 10 }),
      stripe.subscriptions.list({ customer: customerId, status: "trialing", limit: 10 }),
    ]);
    if (active.data.length > 0 || trialing.data.length > 0) {
      throw conflict(
        "An active subscription already exists for this billing account. Manage it from the billing portal.",
      );
    }

    const vendorId = user._id.toHexString();
    const origin = frontendOrigin();
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: getPriceId(plan), quantity: 1 }],
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

    res.json({ success: true, url: session.url, sessionId: session.id });
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
