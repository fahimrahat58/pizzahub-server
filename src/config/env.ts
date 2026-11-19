import "dotenv/config";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const optional = (name: string, fallback: string): string =>
  process.env[name]?.trim() ? (process.env[name] as string) : fallback;

const normalizeOrigin = (origin: string): string => origin.trim().replace(/\/$/, "");

/**
 * CORS never depends on a single deployment environment variable. The exact
 * production frontend and local development origin are always allowed, and
 * FRONTEND_URL may add other explicitly configured origins.
 */
const configuredFrontendOrigins = optional("FRONTEND_URL", "http://localhost:3000")
  .split(",")
  .map(normalizeOrigin)
  .filter(Boolean);

export const corsOrigins: string[] = Array.from(
  new Set([
    "https://pizzahub-mocha.vercel.app",
    "http://localhost:3000",
    ...configuredFrontendOrigins,
  ]),
);

/**
 * Stripe values are deliberately optional at startup so the rest of PizzaHub
 * keeps running when billing is not configured. Endpoints that need Stripe
 * check `isStripeConfigured()` and fail with a clear, non-secret error.
 *
 * These are server-only. They must never be exposed with a NEXT_PUBLIC_ prefix.
 */
const stripeSecretKey = process.env.STRIPE_SECRET_KEY?.trim() ?? "";
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim() ?? "";
const stripePriceIdMonthly = process.env.STRIPE_PRICE_ID_MONTHLY?.trim() ?? "";
const stripePriceIdYearly = process.env.STRIPE_PRICE_ID_YEARLY?.trim() ?? "";
const resendApiKey = process.env.RESEND_API_KEY?.trim() ?? "";
const emailFrom = process.env.EMAIL_FROM?.trim() ?? "";
const nodeEnv = process.env.NODE_ENV?.trim() ?? "";
const resendTestEmail = process.env.RESEND_TEST_EMAIL?.trim() ?? "";

const isPlaceholder = (value: string): boolean =>
  value.length === 0 ||
  value.startsWith("your_") ||
  value === "change-me" ||
  value === "sk_test_replace_me";

export const env = {
  port: Number(optional("PORT", "5000")),
  frontendUrl: optional("FRONTEND_URL", "http://localhost:3000"),
  mongoUri: required("MONGODB_URI"),
  dbName: required("DB_NAME"),
  authUrl: optional("BETTER_AUTH_URL", "http://localhost:3000").replace(/\/$/, ""),
  authSecret: process.env.BETTER_AUTH_SECRET ?? "",
  imgbbApiKey: process.env.IMGBB_API_KEY ?? "",
  stripeSecretKey,
  stripeWebhookSecret,
  stripePriceIdMonthly,
  stripePriceIdYearly,
  resendApiKey,
  emailFrom,
  nodeEnv,
  resendTestEmail,
} as const;

export const isImgBbConfigured = (): boolean =>
  env.imgbbApiKey.length > 0 &&
  !env.imgbbApiKey.startsWith("your_") &&
  env.imgbbApiKey !== "change-me";

export const isEmailConfigured = (): boolean =>
  !isPlaceholder(env.resendApiKey) &&
  !isPlaceholder(env.emailFrom) &&
  env.emailFrom.includes("@");

/**
 * Development-only Resend recipient. This is deliberately gated on NODE_ENV so
 * a verified test address can never replace real vendor/customer recipients in
 * production. Placeholder values are ignored.
 */
export const getDevelopmentEmailRecipient = (): string | null => {
  if (env.nodeEnv !== "development") return null;
  if (isPlaceholder(env.resendTestEmail) || !env.resendTestEmail.includes("@")) {
    return null;
  }
  return env.resendTestEmail;
};

/** True only when all four Stripe values are present and non-placeholder. */
export const isStripeConfigured = (): boolean =>
  !isPlaceholder(env.stripeSecretKey) &&
  !isPlaceholder(env.stripeWebhookSecret) &&
  !isPlaceholder(env.stripePriceIdMonthly) &&
  !isPlaceholder(env.stripePriceIdYearly) &&
  env.stripePriceIdMonthly.startsWith("price_") &&
  env.stripePriceIdYearly.startsWith("price_");

/**
 * Price IDs must be Stripe Price objects (`price_...`), not Product IDs
 * (`prod_...`). This check prevents a confusing Stripe API error at checkout.
 */
export const stripeConfigIssue = (): string | null => {
  if (isStripeConfigured()) return null;
  if (!env.stripeSecretKey) return "STRIPE_SECRET_KEY is not configured";
  if (!env.stripeWebhookSecret) return "STRIPE_WEBHOOK_SECRET is not configured";
  if (!env.stripePriceIdMonthly.startsWith("price_")) {
    return "STRIPE_PRICE_ID_MONTHLY must be a Stripe Price ID (price_...), not a Product ID";
  }
  if (!env.stripePriceIdYearly.startsWith("price_")) {
    return "STRIPE_PRICE_ID_YEARLY must be a Stripe Price ID (price_...), not a Product ID";
  }
  return "Stripe is not fully configured";
};
