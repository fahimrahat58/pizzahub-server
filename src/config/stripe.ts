import Stripe from "stripe";

import {
  env,
  isStripeConfigured,
  isStripePaymentConfigured,
  stripeConfigIssue,
  stripePaymentConfigIssue,
} from "./env.js";

let client: Stripe | null = null;

const stripeClient = (): Stripe => {
  if (!client) {
    client = new Stripe(env.stripeSecretKey);
  }
  return client;
};

/**
 * Server-only Stripe singleton for customer one-time payments. Never import
 * this from client code and never expose the key through a NEXT_PUBLIC_ variable.
 */
export const getStripeForPayments = (): Stripe => {
  if (!isStripePaymentConfigured()) {
    throw new Error(
      stripePaymentConfigIssue() ?? "Customer payments are not configured",
    );
  }
  return stripeClient();
};

/**
 * Existing vendor-subscription client. Keeps requiring both recurring Price IDs
 * so subscription behavior is unchanged.
 */
export const getStripe = (): Stripe => {
  if (!isStripeConfigured()) {
    throw new Error(stripeConfigIssue() ?? "Stripe is not configured");
  }
  return stripeClient();
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
