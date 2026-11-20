import { MongoServerError, ObjectId, type Document } from "mongodb";
import type Stripe from "stripe";

import { collections } from "../config/database.js";
import { env } from "../config/env.js";
import { isValidObjectId } from "../utils/query.js";
import type {
  BillingInterval,
  CheckoutLockDoc,
  BillingPlanId,
  PaymentStatus,
  StoredSubscriptionPlan,
  SubscriptionEventDoc,
  SubscriptionPlan,
  SubscriptionStatus,
  TransactionDoc,
  UserDoc,
} from "../types/models.js";

/** Free vendors may have at most three approved, active menu items. */
export const FREE_ITEM_LIMIT = 3;

/** Free vendors may own at most three restaurants. */
export const FREE_RESTAURANT_LIMIT = 3;

/** Every field the authoritative Premium calculation needs. */
export const SUBSCRIPTION_STATE_PROJECTION: Record<string, 1> = {
  subscriptionPlan: 1,
  subscriptionStatus: 1,
  subscriptionExpiresAt: 1,
  cancelAt: 1,
  cancelAtPeriodEnd: 1,
  endedAt: 1,
  canceledAt: 1,
};

const ACTIVE_STATUSES: SubscriptionStatus[] = ["active", "trialing"];
/** Statuses after which Stripe will not resume the same subscription. */
const TERMINAL_STATUSES: SubscriptionStatus[] = ["canceled", "incomplete_expired"];
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

const isTerminalSubscriptionStatus = (
  status?: SubscriptionStatus | null,
): boolean => !!status && TERMINAL_STATUSES.includes(status);

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
  canceledAt: Date | null;
  /** null means unlimited. */
  activeItemLimit: number | null;
  /** null means unlimited. */
  activeRestaurantLimit: number | null;
}

type SubscriptionState = Pick<
  UserDoc,
  | "subscriptionPlan"
  | "subscriptionStatus"
  | "subscriptionExpiresAt"
  | "cancelAt"
  | "cancelAtPeriodEnd"
  | "endedAt"
  | "canceledAt"
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
  const ended = user.endedAt != null;

  // Pre-Stripe `pro` users have no status/expiry; keep them Premium.
  const active = status ? isActiveSubscriptionStatus(status) : plan === "premium";
  const isPremium = active && !expired && !ended;

  return {
    plan: isPremium ? "premium" : "free",
    status:
      status ??
      (plan === "premium" && !expired ? "active" : "none"),
    isPremium,
    expiresAt,
    cancelAtPeriodEnd: isPremium && (user.cancelAtPeriodEnd ?? false),
    canceledAt: user.endedAt ?? user.canceledAt ?? null,
    activeItemLimit: isPremium ? null : FREE_ITEM_LIMIT,
    activeRestaurantLimit: isPremium ? null : FREE_RESTAURANT_LIMIT,
  };
};

export const isPremiumUser = (user: SubscriptionState): boolean =>
  getEffectiveSubscription(user).isPremium;

/** Resolves currently Premium vendors from trusted MongoDB subscription state. */
export const getPremiumVendorIds = async (
  vendorIds: Iterable<string>,
): Promise<Set<string>> => {
  const objectIds = [...new Set(vendorIds)]
    .filter((vendorId) => isValidObjectId(vendorId))
    .map((vendorId) => new ObjectId(vendorId));
  if (objectIds.length === 0) return new Set();

  const vendors = await collections
    .users()
    .find(
      { _id: { $in: objectIds } },
      { projection: SUBSCRIPTION_STATE_PROJECTION },
    )
    .toArray();

  return new Set(
    vendors.filter((vendor) => isPremiumUser(vendor)).map((vendor) => vendor._id.toHexString()),
  );
};

export const normalizeStripeStatus = (status: string): SubscriptionStatus => {
  const match = KNOWN_STATUSES.find((value) => value === status);
  if (match) return match;
  console.warn("Stripe subscription used an unrecognised status:", status);
  return "incomplete";
};

type StripeSubscriptionState = Pick<
  Stripe.Subscription,
  | "id"
  | "customer"
  | "status"
  | "metadata"
  | "cancel_at"
  | "cancel_at_period_end"
  | "canceled_at"
  | "ended_at"
  | "items"
>;

export type SubscriptionSyncInput = StripeSubscriptionState & {
  eventId?: string;
  eventCreated?: number;
  checkoutSessionId?: string | null;
  /** Invoice events do not carry this flag, so keep the stored value. */
  preserveCancelAtPeriodEnd?: boolean;
  /** Live status reconciliation must not advance the webhook event watermark. */
  preserveEventMetadata?: boolean;
  /** subscription.deleted is authoritative even if Stripe's snapshot lags. */
  statusOverride?: SubscriptionStatus;
};

export type CheckoutSessionSyncInput = {
  eventId: string;
  eventCreated: number;
  sessionId: string;
  customerId?: string | null;
  vendorId?: string | null;
  plan?: BillingPlanId | null;
};

/**
 * Stripe API 2025-03-31 moved period boundaries onto subscription items.
 * Use the earliest item start and latest item end for the subscription period.
 */
const periodStartOf = (subscription: StripeSubscriptionState): number => {
  const starts = (subscription.items?.data ?? [])
    .map((item) => item.current_period_start)
    .filter((value): value is number => typeof value === "number");
  return starts.length > 0 ? Math.min(...starts) : 0;
};

const periodEndOf = (subscription: StripeSubscriptionState): number => {
  const ends = (subscription.items?.data ?? [])
    .map((item) => item.current_period_end)
    .filter((value): value is number => typeof value === "number");
  return ends.length > 0 ? Math.max(...ends) : 0;
};

const cancelAtOf = (subscription: StripeSubscriptionState): number | null =>
  typeof subscription.cancel_at === "number" && Number.isFinite(subscription.cancel_at)
    ? subscription.cancel_at
    : null;

const endedAtOf = (subscription: StripeSubscriptionState): number | null =>
  typeof subscription.ended_at === "number" && Number.isFinite(subscription.ended_at)
    ? subscription.ended_at
    : null;

const customerIdOf = (customer: string | { id: string } | Stripe.DeletedCustomer): string =>
  typeof customer === "string" ? customer : customer.id;

const BILLING_PLAN_IDS: BillingPlanId[] = ["monthly", "yearly"];

/** Only accept billing plan IDs PizzaHub itself writes into Stripe metadata. */
const billingPlanIdOf = (metadata?: Stripe.Metadata | null): BillingPlanId | null => {
  const plan = metadata?.plan;
  return BILLING_PLAN_IDS.find((value) => value === plan) ?? null;
};

const priceIdOf = (subscription: StripeSubscriptionState): string | null => {
  for (const item of subscription.items?.data ?? []) {
    if (item.price?.id) return item.price.id;
  }
  return null;
};

/** Maps a Price ID to the plan it was configured for. Never infers from metadata. */
const configuredIntervalOf = (priceId: string | null): BillingInterval | null => {
  if (!priceId) return null;
  if (priceId === env.stripePriceIdMonthly) return "month";
  if (priceId === env.stripePriceIdYearly) return "year";
  return null;
};

/**
 * The purchased cycle comes from the Price attached to Stripe's subscription
 * snapshot. Configured Price IDs are a safe fallback for older snapshots that
 * omit `recurring`; metadata is only a last-resort legacy fallback.
 */
const billingIntervalOf = (subscription: StripeSubscriptionState): BillingInterval | null => {
  for (const item of subscription.items?.data ?? []) {
    const interval = item.price?.recurring?.interval;
    if (interval === "month" || interval === "year") return interval as BillingInterval;

    const configured = configuredIntervalOf(item.price?.id ?? null);
    if (configured) return configured;
  }

  const configured = configuredIntervalOf(priceIdOf(subscription));
  if (configured) return configured;

  const legacyPlan = billingPlanIdOf(subscription.metadata);
  return legacyPlan === "monthly" ? "month" : legacyPlan === "yearly" ? "year" : null;
};

/**
 * Resolves the vendor from the stored Stripe customer/subscription mapping
 * first. Metadata is a PizzaHub-written hint only: a conflicting metadata
 * vendor is rejected instead of reassigning another vendor's subscription.
 * Email is never trusted.
 */
const resolveVendor = async (
  subscription: StripeSubscriptionState,
  customerId: string,
  eventId?: string,
): Promise<UserDoc | null> => {
  const metadataVendorId = subscription.metadata?.vendorId;
  const [byCustomer, bySubscription, byMetadata] = await Promise.all([
    collections.users().findOne({ stripeCustomerId: customerId, role: "vendor" }),
    collections.users().findOne({ stripeSubscriptionId: subscription.id, role: "vendor" }),
    metadataVendorId && isValidObjectId(metadataVendorId)
      ? collections.users().findOne({
          _id: new ObjectId(metadataVendorId),
          role: "vendor",
        })
      : Promise.resolve(null),
  ]);

  const candidates = [byCustomer, bySubscription, byMetadata].filter(
    (value): value is UserDoc => value !== null,
  );
  const distinctOwners = new Set(candidates.map((value) => value._id.toHexString()));
  const vendor = byCustomer ?? bySubscription ?? byMetadata ?? null;

  console.log("Stripe subscription vendor lookup", {
    eventId: eventId ?? null,
    subscriptionId: subscription.id,
    customerId,
    metadataVendorId: metadataVendorId ?? null,
    vendorId: vendor?._id.toHexString() ?? null,
    matchedBy: byCustomer
      ? "customer"
      : bySubscription
        ? "subscription"
        : byMetadata
          ? "metadata"
          : "none",
  });

  if (distinctOwners.size > 1) {
    console.warn("Stripe subscription ignored: conflicting ownership metadata", {
      subscriptionId: subscription.id,
      customerId,
    });
    return null;
  }

  return vendor;
};

/**
 * Applies a Stripe subscription snapshot to MongoDB. Only called from the
 * verified webhook handler. The update is conditional on the prior Stripe
 * identity and event age, so delayed events and concurrent writes cannot roll
 * Premium back to an older state.
 */
export const syncSubscription = async (
  input: SubscriptionSyncInput,
): Promise<UserDoc | null> => {
  const {
    eventId,
    eventCreated,
    checkoutSessionId,
    preserveCancelAtPeriodEnd,
    preserveEventMetadata,
    statusOverride,
    ...subscription
  } = input;
  const customerId = customerIdOf(subscription.customer);
  const vendor = await resolveVendor(subscription, customerId, eventId);

  if (!vendor) {
    console.warn("Stripe subscription ignored: no matching vendor", {
      subscriptionId: subscription.id,
      customerId,
    });
    return null;
  }

  const endedAt = endedAtOf(subscription);
  const status =
    statusOverride ??
    (endedAt !== null ? "canceled" : normalizeStripeStatus(subscription.status));
  const incomingActive = isActiveSubscriptionStatus(status);
  const replacingSubscription =
    Boolean(vendor.stripeSubscriptionId) && vendor.stripeSubscriptionId !== subscription.id;
  const canReplaceTerminal =
    isTerminalSubscriptionStatus(vendor.subscriptionStatus) && incomingActive;

  // A stored customer can never be reassigned. A different subscription may
  // replace a terminal one only when the incoming subscription is active.
  if (
    (vendor.stripeCustomerId && vendor.stripeCustomerId !== customerId) ||
    (replacingSubscription && !canReplaceTerminal)
  ) {
    console.warn("Stripe subscription ignored: identity mismatch", {
      subscriptionId: subscription.id,
      vendorId: vendor._id.toHexString(),
    });
    return null;
  }

  const eventSeconds =
    typeof eventCreated === "number" && Number.isFinite(eventCreated)
      ? eventCreated
      : Math.floor(Date.now() / 1000);
  const eventAt = new Date(eventSeconds * 1000);
  const plan: SubscriptionPlan = incomingActive ? "premium" : "free";
  const periodStart = periodStartOf(subscription);
  const periodEnd = periodEndOf(subscription);
  const cancelAt = cancelAtOf(subscription);
  const isTerminal = isTerminalSubscriptionStatus(status) || endedAt !== null;
  const scheduledCancellation =
    subscription.cancel_at_period_end === true || cancelAt !== null;

  // Stripe's cancel_at can move the effective end earlier than the invoice
  // period. ended_at is authoritative once the subscription has actually ended.
  const effectivePeriodEnd = [periodEnd, cancelAt, endedAt]
    .filter((value): value is number => typeof value === "number" && value > 0)
    .reduce<number | null>((earliest, value) => (earliest === null ? value : Math.min(earliest, value)), null);

  const billingInterval = billingIntervalOf(subscription) ?? vendor.billingInterval ?? null;
  const billingPlanId: BillingPlanId | null =
    billingInterval === "month"
      ? "monthly"
      : billingInterval === "year"
        ? "yearly"
        : billingPlanIdOf(subscription.metadata) ?? vendor.billingPlanId ?? null;

  // While a cancellation is only scheduled, Stripe's canceled_at may already
  // contain the request time. Do not show the subscription as canceled until
  // ended_at or a terminal status proves it actually ended.
  const canceledAtSeconds = isTerminal
    ? endedAt ?? subscription.canceled_at ?? eventSeconds
    : null;
  const canceledAt = canceledAtSeconds ? new Date(canceledAtSeconds * 1000) : null;

  // Build an atomic guard from the vendor snapshot we just validated. Every
  // condition must still hold when MongoDB applies the update.
  const filter: Document = { _id: vendor._id, role: "vendor" };
  const conditions: Document[] = [];

  if (vendor.stripeSubscriptionId) {
    filter.stripeSubscriptionId = vendor.stripeSubscriptionId;
  } else {
    conditions.push({
      $or: [
        { stripeSubscriptionId: { $exists: false } },
        { stripeSubscriptionId: null },
      ],
    });
  }

  conditions.push({
    $or: [
      { subscriptionEventCreatedAt: { $exists: false } },
      { subscriptionEventCreatedAt: null },
      { subscriptionEventCreatedAt: { $lte: eventAt } },
    ],
  });

  // A renewal cannot move the period end backwards for the same subscription.
  // A brand-new subscription replacing a canceled one is allowed to differ, as
  // is a newer cancellation event, which legitimately shortens the effective
  // end via cancel_at/ended_at. Event age already prevents out-of-order writes.
  if (
    !replacingSubscription &&
    !scheduledCancellation &&
    !isTerminal &&
    effectivePeriodEnd !== null
  ) {
    conditions.push({
      $or: [
        { subscriptionExpiresAt: { $exists: false } },
        { subscriptionExpiresAt: null },
        { subscriptionExpiresAt: { $lte: new Date(effectivePeriodEnd * 1000) } },
      ],
    });
  }

  if (conditions.length > 0) filter.$and = conditions;

  const updateResult = await collections.users().updateOne(filter, {
    $set: {
      subscriptionPlan: plan,
      subscriptionStatus: status,
      billingPlanId,
      billingInterval,
      stripePriceId: priceIdOf(subscription) ?? vendor.stripePriceId ?? null,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscription.id,
      stripeCheckoutSessionId: checkoutSessionId ?? vendor.stripeCheckoutSessionId ?? null,
      currentPeriodStart: periodStart > 0 ? new Date(periodStart * 1000) : null,
      currentPeriodEnd: periodEnd > 0 ? new Date(periodEnd * 1000) : null,
      subscriptionExpiresAt:
        effectivePeriodEnd !== null ? new Date(effectivePeriodEnd * 1000) : null,
      cancelAt: cancelAt !== null ? new Date(cancelAt * 1000) : null,
      cancelAtPeriodEnd: preserveCancelAtPeriodEnd
        ? vendor.cancelAtPeriodEnd ?? false
        : !isTerminal && scheduledCancellation,
      endedAt: endedAt !== null ? new Date(endedAt * 1000) : null,
      canceledAt,
      subscriptionEventCreatedAt: preserveEventMetadata
        ? vendor.subscriptionEventCreatedAt ?? null
        : eventAt,
      subscriptionEventId: preserveEventMetadata
        ? vendor.subscriptionEventId ?? null
        : eventId ?? null,
      updatedAt: new Date(),
    },
  });

  console.log("Stripe subscription MongoDB update", {
    eventId: eventId ?? null,
    subscriptionId: subscription.id,
    vendorId: vendor._id.toHexString(),
    status,
    billingInterval,
    cancelAtPeriodEnd: !isTerminal && scheduledCancellation,
    matchedCount: updateResult.matchedCount,
    modifiedCount: updateResult.modifiedCount,
  });

  if (updateResult.matchedCount === 0) {
    console.warn("Stripe subscription event was stale or superseded", {
      eventId: eventId ?? null,
      subscriptionId: subscription.id,
      vendorId: vendor._id.toHexString(),
    });
    return null;
  }

  // Read back the document written by this event. The conditional update above
  // is the atomic guard; this lookup only supplies the post-update snapshot.
  const updated = await collections.users().findOne(
    eventId
      ? { _id: vendor._id, role: "vendor", subscriptionEventId: eventId }
      : { _id: vendor._id, role: "vendor" },
  );

  return updated ?? null;
};

/**
 * Links a verified Checkout Session to the vendor without changing plan state.
 * Plan activation still requires a subscription lifecycle webhook.
 */
export const syncCheckoutSession = async (
  input: CheckoutSessionSyncInput,
): Promise<UserDoc | null> => {
  const metadataVendorId = input.vendorId;
  const [byCustomer, byMetadata] = await Promise.all([
    input.customerId
      ? collections.users().findOne({ stripeCustomerId: input.customerId, role: "vendor" })
      : Promise.resolve(null),
    metadataVendorId && isValidObjectId(metadataVendorId)
      ? collections.users().findOne({
          _id: new ObjectId(metadataVendorId),
          role: "vendor",
        })
      : Promise.resolve(null),
  ]);

  const candidates = [byCustomer, byMetadata].filter(
    (value): value is UserDoc => value !== null,
  );
  const distinctOwners = new Set(candidates.map((value) => value._id.toHexString()));
  const vendor = byCustomer ?? byMetadata ?? null;

  console.log("Stripe checkout vendor lookup", {
    eventId: input.eventId,
    sessionId: input.sessionId,
    customerId: input.customerId ?? null,
    metadataVendorId: metadataVendorId ?? null,
    vendorId: vendor?._id.toHexString() ?? null,
    matchedBy: byCustomer ? "customer" : byMetadata ? "metadata" : "none",
  });

  if (distinctOwners.size > 1) {
    console.warn("Stripe checkout ignored: conflicting ownership metadata", {
      sessionId: input.sessionId,
      customerId: input.customerId ?? null,
    });
    return null;
  }

  if (!vendor) {
    console.warn("Stripe checkout ignored: no matching vendor", {
      sessionId: input.sessionId,
      customerId: input.customerId ?? null,
    });
    return null;
  }

  if (
    vendor.stripeCustomerId &&
    input.customerId &&
    vendor.stripeCustomerId !== input.customerId
  ) {
    console.warn("Stripe checkout ignored: customer identity mismatch", {
      sessionId: input.sessionId,
      vendorId: vendor._id.toHexString(),
    });
    return null;
  }

  const eventSeconds =
    typeof input.eventCreated === "number" && Number.isFinite(input.eventCreated)
      ? input.eventCreated
      : Math.floor(Date.now() / 1000);
  const eventAt = new Date(eventSeconds * 1000);
  const filter: Document = { _id: vendor._id, role: "vendor" };
  if (input.customerId) filter.stripeCustomerId = input.customerId;
  filter.$and = [
    {
      $or: [
        { stripeCheckoutSessionId: { $exists: false } },
        { stripeCheckoutSessionId: null },
        { stripeCheckoutSessionId: input.sessionId },
        { checkoutEventCreatedAt: { $exists: false } },
        { checkoutEventCreatedAt: null },
        { checkoutEventCreatedAt: { $lte: eventAt } },
      ],
    },
  ];

  const updateResult = await collections.users().updateOne(filter, {
    $set: {
      stripeCheckoutSessionId: input.sessionId,
      checkoutEventCreatedAt: eventAt,
      billingPlanId: input.plan ?? vendor.billingPlanId ?? null,
      updatedAt: new Date(),
    },
  });

  console.log("Stripe checkout MongoDB update", {
    eventId: input.eventId,
    sessionId: input.sessionId,
    vendorId: vendor._id.toHexString(),
    matchedCount: updateResult.matchedCount,
    modifiedCount: updateResult.modifiedCount,
  });

  if (updateResult.matchedCount === 0) {
    console.warn("Stripe checkout event was stale or superseded", {
      eventId: input.eventId,
      sessionId: input.sessionId,
      vendorId: vendor._id.toHexString(),
    });
    return null;
  }

  const updated = await collections.users().findOne({
    _id: vendor._id,
    role: "vendor",
    stripeCheckoutSessionId: input.sessionId,
    checkoutEventCreatedAt: eventAt,
  });

  return updated ?? null;
};

export type StripeEventClaim = "new" | "duplicate" | "processing";

// Long enough for a slow in-flight webhook, short enough that a crashed worker
// cannot block Stripe's retries indefinitely.
const STRIPE_EVENT_CLAIM_TTL_MS = 60_000;

/** Claims an event id so duplicate webhook deliveries are safe to ignore. */
export const claimStripeEvent = async (
  eventId: string,
  type: string,
  vendorId?: string | null,
): Promise<StripeEventClaim> => {
  const now = new Date();
  try {
    await collections.stripeEvents().insertOne({
      _id: eventId,
      type,
      vendorId: vendorId ?? null,
      status: "processing",
      createdAt: now,
    });
    return "new";
  } catch (error) {
    if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;

    const existing = await collections.stripeEvents().findOne(
      { _id: eventId },
      { projection: { status: 1, createdAt: 1 } },
    );
    if (!existing || existing.status === "processed") return "duplicate";

    if (existing.status === "processing") {
      const cutoff = new Date(now.getTime() - STRIPE_EVENT_CLAIM_TTL_MS);
      const reclaimed = await collections.stripeEvents().findOneAndUpdate(
        { _id: eventId, status: "processing", createdAt: { $lt: cutoff } },
        {
          $set: {
            type,
            vendorId: vendorId ?? null,
            status: "processing",
            createdAt: now,
          },
        },
        { returnDocument: "after" },
      );
      if (reclaimed) return "new";
    }
    return "processing";
  }
};

export const completeStripeEvent = async (eventId: string): Promise<void> => {
  await collections.stripeEvents().updateOne(
    { _id: eventId, status: "processing" },
    { $set: { status: "processed", processedAt: new Date() } },
  );
};

/** Releases a claim on failure so Stripe can retry the webhook. */
export const releaseStripeEvent = async (eventId: string): Promise<void> => {
  // Never erase a row another delivery has already marked processed.
  await collections.stripeEvents().deleteOne({ _id: eventId, status: "processing" });
};

// Long enough to cover an in-flight API call, short enough that an abandoned
// Checkout Session cannot block a legitimate retry for long.
const CHECKOUT_LOCK_TTL_MS = 60_000;

/**
 * Atomically claims a short-lived checkout mutex for one vendor. The lock only
 * prevents simultaneous Checkout Sessions; Stripe remains authoritative for
 * whether a real subscription exists.
 */
export const acquireCheckoutLock = async (
  vendorId: string,
  plan: BillingPlanId,
): Promise<boolean> => {
  const now = new Date();
  const document: CheckoutLockDoc = {
    _id: vendorId,
    vendorId,
    plan,
    sessionId: null,
    createdAt: now,
    expiresAt: new Date(now.getTime() + CHECKOUT_LOCK_TTL_MS),
  };

  try {
    await collections.checkoutLocks().insertOne(document);
    return true;
  } catch (error) {
    if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;

    // A stale lock may block a legitimate new purchase. Replace it only when
    // MongoDB confirms it has expired; a live lock always wins.
    const result = await collections.checkoutLocks().updateOne(
      { _id: vendorId, expiresAt: { $lte: now } },
      { $set: document },
    );
    return result.modifiedCount > 0;
  }
};

export const markCheckoutLockSession = async (
  vendorId: string,
  sessionId: string,
): Promise<void> => {
  await collections
    .checkoutLocks()
    .updateOne({ _id: vendorId }, { $set: { sessionId } });
};

export const releaseCheckoutLock = async (
  vendorId: string,
  sessionId?: string | null,
): Promise<void> => {
  await collections.checkoutLocks().deleteOne({
    _id: vendorId,
    ...(sessionId ? { sessionId } : {}),
  });
};

export const recordSubscriptionEvent = async (input: {
  eventId: string;
  type: string;
  vendorId: string;
  plan?: SubscriptionPlan | null;
  billingInterval?: BillingInterval | null;
  status?: SubscriptionStatus | null;
  description?: string | null;
}): Promise<void> => {
  const document: SubscriptionEventDoc = {
    _id: new ObjectId(),
    vendorId: input.vendorId,
    stripeEventId: input.eventId,
    type: input.type,
    plan: input.plan ?? null,
    billingInterval: input.billingInterval ?? null,
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
  billingInterval?: BillingInterval | null;
  amount: number;
  currency: string;
  status: SubscriptionStatus;
  subscriptionId?: string | null;
  invoiceId?: string | null;
  description?: string | null;
}): Promise<void> => {
  const vendor = await collections
    .users()
    .findOne({ _id: new ObjectId(input.vendorId) });
  if (!vendor) return;

  const paymentStatus: PaymentStatus =
    input.status === "active" || input.status === "trialing"
      ? "paid"
      : input.status === "incomplete"
        ? "pending"
        : "failed";

  const document: TransactionDoc = {
    _id: new ObjectId(),
    paymentType: "vendor_subscription",
    vendorId: input.vendorId,
    vendorName: vendor.name,
    vendorEmail: vendor.email,
    plan: input.plan ?? "premium",
    amount: input.amount,
    currency: input.currency.toUpperCase(),
    status: input.status,
    paymentStatus,
    paymentMethod: "stripe",
    stripeEventId: input.eventId,
    ...(input.invoiceId ? { stripeInvoiceId: input.invoiceId } : {}),
    billingInterval: input.billingInterval ?? null,
    stripeSubscriptionId: input.subscriptionId ?? null,
    description: input.description ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // Stripe event ids protect against retries. Invoice ids additionally collapse
  // the initial checkout and its invoice events into one genuine payment.
  const filter = input.invoiceId
    ? { stripeInvoiceId: input.invoiceId }
    : { stripeEventId: input.eventId };

  try {
    await collections
      .transactions()
      .updateOne(filter, { $setOnInsert: document }, { upsert: true });
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 11000) return;
    throw error;
  }
};
