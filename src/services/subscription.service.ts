import { MongoServerError, ObjectId } from "mongodb";
import type Stripe from "stripe";

import { collections } from "../config/database.js";
import { isValidObjectId } from "../utils/query.js";
import type {
  StoredSubscriptionPlan,
  SubscriptionEventDoc,
  SubscriptionPlan,
  SubscriptionStatus,
  TransactionDoc,
  UserDoc,
} from "../types/models.js";

/** Free vendors may have at most three approved, active menu items. */
export const FREE_ITEM_LIMIT = 3;

const ACTIVE_STATUSES: SubscriptionStatus[] = ["active", "trialing"];
const KNOWN_STATUSES: SubscriptionStatus[] = [
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "incomplete",
  "incomplete_expired",
  "canceled",
  "paused",
];

export const isActiveSubscriptionStatus = (
  status?: SubscriptionStatus | null,
): boolean => !!status && ACTIVE_STATUSES.includes(status);

/** Legacy `pro` documents are treated as Premium everywhere. */
export const normalizePlan = (
  plan?: StoredSubscriptionPlan | null,
): SubscriptionPlan => (plan === "premium" || plan === "pro" ? "premium" : "free");

export interface EffectiveSubscription {
  plan: SubscriptionPlan;
  status: SubscriptionStatus | "none";
  isPremium: boolean;
  expiresAt: Date | null;
  cancelAtPeriodEnd: boolean;
  /** null means unlimited. */
  activeItemLimit: number | null;
}

type SubscriptionState = Pick<
  UserDoc,
  | "subscriptionPlan"
  | "subscriptionStatus"
  | "subscriptionExpiresAt"
  | "cancelAtPeriodEnd"
>;

/**
 * The single source of truth for whether a user currently has Premium.
 * Free/Premium is derived from trusted MongoDB fields written by webhooks only.
 */
export const getEffectiveSubscription = (
  user: SubscriptionState,
): EffectiveSubscription => {
  const plan = normalizePlan(user.subscriptionPlan);
  const status = user.subscriptionStatus ?? null;
  const expiresAt = user.subscriptionExpiresAt ?? null;
  const expired = expiresAt !== null && expiresAt.getTime() <= Date.now();

  // Pre-Stripe `pro` users have no status/expiry; keep them Premium.
  const active = status ? isActiveSubscriptionStatus(status) : plan === "premium";
  const isPremium = active && !expired;

  return {
    plan: isPremium ? "premium" : "free",
    status:
      status ??
      (plan === "premium" && !expired ? "active" : "none"),
    isPremium,
    expiresAt,
    cancelAtPeriodEnd: isPremium && (user.cancelAtPeriodEnd ?? false),
    activeItemLimit: isPremium ? null : FREE_ITEM_LIMIT,
  };
};

export const isPremiumUser = (user: SubscriptionState): boolean =>
  getEffectiveSubscription(user).isPremium;

export const normalizeStripeStatus = (status: string): SubscriptionStatus => {
  const match = KNOWN_STATUSES.find((value) => value === status);
  if (match) return match;
  console.warn("Stripe subscription used an unrecognised status:", status);
  return "incomplete";
};

type StripeSubscriptionState = Pick<
  Stripe.Subscription,
  "id" | "customer" | "status" | "metadata" | "cancel_at_period_end" | "items"
>;

/**
 * Stripe API 2025-03-31 moved period boundaries onto subscription items.
 * Use the latest item period end as the renewal/expiration timestamp.
 */
const periodEndOf = (subscription: StripeSubscriptionState): number => {
  const ends = (subscription.items?.data ?? [])
    .map((item) => item.current_period_end)
    .filter((value): value is number => typeof value === "number");
  return ends.length > 0 ? Math.max(...ends) : 0;
};

const customerIdOf = (customer: string | { id: string } | Stripe.DeletedCustomer): string =>
  typeof customer === "string" ? customer : customer.id;

/**
 * Resolves the vendor from data PizzaHub itself wrote to Stripe metadata, then
 * falls back to the stored customer/subscription ids. Email is never trusted.
 */
const resolveVendor = async (
  subscription: StripeSubscriptionState,
  customerId: string,
): Promise<UserDoc | null> => {
  const metadataVendorId = subscription.metadata?.vendorId;

  if (metadataVendorId && isValidObjectId(metadataVendorId)) {
    const byMetadata = await collections.users().findOne({
      _id: new ObjectId(metadataVendorId),
      role: "vendor",
    });
    if (byMetadata) return byMetadata;
  }

  const byCustomer = await collections.users().findOne({
    stripeCustomerId: customerId,
    role: "vendor",
  });
  if (byCustomer) return byCustomer;

  const bySubscription = await collections.users().findOne({
    stripeSubscriptionId: subscription.id,
    role: "vendor",
  });
  return bySubscription ?? null;
};

/**
 * Applies a Stripe subscription snapshot to MongoDB. Only called from the
 * verified webhook handler.
 */
export const syncSubscription = async (
  subscription: StripeSubscriptionState,
): Promise<UserDoc | null> => {
  const customerId = customerIdOf(subscription.customer);
  const vendor = await resolveVendor(subscription, customerId);

  if (!vendor) {
    console.warn("Stripe subscription ignored: no matching vendor", {
      subscriptionId: subscription.id,
      customerId,
    });
    return null;
  }

  // Prevent a customer/sub id from being reassigned to a different vendor.
  if (
    (vendor.stripeCustomerId && vendor.stripeCustomerId !== customerId) ||
    (vendor.stripeSubscriptionId && vendor.stripeSubscriptionId !== subscription.id)
  ) {
    console.warn("Stripe subscription ignored: identity mismatch", {
      subscriptionId: subscription.id,
      vendorId: vendor._id.toHexString(),
    });
    return null;
  }

  const status = normalizeStripeStatus(subscription.status);
  const plan: SubscriptionPlan = isActiveSubscriptionStatus(status)
    ? "premium"
    : "free";
  const periodEnd = periodEndOf(subscription);

  const updated = await collections.users().findOneAndUpdate(
    { _id: vendor._id, role: "vendor" },
    {
      $set: {
        subscriptionPlan: plan,
        subscriptionStatus: status,
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscription.id,
        subscriptionExpiresAt: periodEnd > 0 ? new Date(periodEnd * 1000) : null,
        cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
        updatedAt: new Date(),
      },
    },
    { returnDocument: "after" },
  );

  return updated ?? null;
};

export type StripeEventClaim = "new" | "duplicate";

/** Claims an event id so duplicate webhook deliveries are safe to ignore. */
export const claimStripeEvent = async (
  eventId: string,
  type: string,
  vendorId?: string | null,
): Promise<StripeEventClaim> => {
  try {
    await collections.stripeEvents().insertOne({
      _id: eventId,
      type,
      vendorId: vendorId ?? null,
      status: "processing",
      createdAt: new Date(),
    });
    return "new";
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 11000) {
      return "duplicate";
    }
    throw error;
  }
};

export const completeStripeEvent = async (eventId: string): Promise<void> => {
  await collections.stripeEvents().updateOne(
    { _id: eventId },
    { $set: { status: "processed", processedAt: new Date() } },
  );
};

/** Releases a claim on failure so Stripe can retry the webhook. */
export const releaseStripeEvent = async (eventId: string): Promise<void> => {
  await collections.stripeEvents().deleteOne({ _id: eventId });
};

export const recordSubscriptionEvent = async (input: {
  eventId: string;
  type: string;
  vendorId: string;
  plan?: SubscriptionPlan | null;
  status?: SubscriptionStatus | null;
  description?: string | null;
}): Promise<void> => {
  const document: SubscriptionEventDoc = {
    _id: new ObjectId(),
    vendorId: input.vendorId,
    stripeEventId: input.eventId,
    type: input.type,
    plan: input.plan ?? null,
    status: input.status ?? null,
    description: input.description ?? null,
    createdAt: new Date(),
  };

  await collections
    .subscriptionEvents()
    .updateOne(
      { stripeEventId: input.eventId },
      { $setOnInsert: document },
      { upsert: true },
    );
};

/** Records a payment transaction from a verified Stripe webhook event. */
export const recordTransaction = async (input: {
  eventId: string;
  vendorId: string;
  plan?: SubscriptionPlan | null;
  amount: number;
  currency: string;
  status: SubscriptionStatus;
  subscriptionId?: string | null;
  description?: string | null;
}): Promise<void> => {
  const vendor = await collections
    .users()
    .findOne({ _id: new ObjectId(input.vendorId) });
  if (!vendor) return;

  const document: TransactionDoc = {
    _id: new ObjectId(),
    vendorId: input.vendorId,
    vendorName: vendor.name,
    vendorEmail: vendor.email,
    plan: input.plan ?? "premium",
    amount: input.amount,
    currency: input.currency.toUpperCase(),
    status: input.status,
    stripeEventId: input.eventId,
    stripeSubscriptionId: input.subscriptionId ?? null,
    description: input.description ?? null,
    createdAt: new Date(),
  };

  // Idempotent by event id: a retried webhook never creates a duplicate.
  await collections
    .transactions()
    .updateOne(
      { stripeEventId: input.eventId },
      { $setOnInsert: document },
      { upsert: true },
    );
};
