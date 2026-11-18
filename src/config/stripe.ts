import Stripe from "stripe";

import { env, isStripeConfigured, stripeConfigIssue } from "./env.js";

let client: Stripe | null = null;

/**
 * Server-only Stripe singleton. Never import this from client code and never
 * expose the key through a NEXT_PUBLIC_ environment variable.
 */
export const getStripe = (): Stripe => {
  if (!isStripeConfigured()) {
    throw new Error(stripeConfigIssue() ?? "Stripe is not configured");
  }
  if (!client) {
    client = new Stripe(env.stripeSecretKey);
  }
  return client;
};

export type BillingPlan = "monthly" | "yearly";

export const getPriceId = (plan: BillingPlan): string => {
  const priceId =
    plan === "monthly" ? env.stripePriceIdMonthly : env.stripePriceIdYearly;
  if (!priceId.startsWith("price_")) {
    throw new Error(
      `Stripe ${plan} Price ID is missing or invalid. Use a price_... ID, not a prod_... Product ID.`,
    );
  }
  return priceId;
};
