import "dotenv/config";
import { MongoClient } from "mongodb";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const db = client.db(process.env.DB_NAME);

const listAll = async (factory) => {
  const out = [];
  let startingAfter;
  for (;;) {
    const page = await factory(startingAfter);
    out.push(...page.data);
    if (!page.has_more) break;
    startingAfter = page.data.at(-1)?.id;
    if (!startingAfter) break;
  }
  return out;
};

const stripeSubscriptions = await listAll((startingAfter) =>
  stripe.subscriptions.list({
    status: "all",
    limit: 100,
    starting_after: startingAfter,
    expand: ["data.items.data.price"],
  }),
);
const stripeEvents = await listAll((startingAfter) =>
  stripe.events.list({ limit: 100, starting_after: startingAfter }),
);
const subById = new Map(stripeSubscriptions.map((sub) => [sub.id, sub]));
const stripeSubIds = new Set(subById.keys());

const relevantFields = [
  "stripeCustomerId",
  "stripeSubscriptionId",
  "stripePriceId",
  "stripeCheckoutSessionId",
  "subscriptionPlan",
  "subscriptionStatus",
  "billingPlanId",
  "billingInterval",
  "currentPeriodStart",
  "currentPeriodEnd",
  "subscriptionExpiresAt",
  "cancelAtPeriodEnd",
  "cancelAt",
  "canceledAt",
  "endedAt",
  "subscriptionEventId",
  "subscriptionEventCreatedAt",
  "checkoutEventCreatedAt",
];

const collectionNames = (await db.listCollections().toArray()).map((entry) => entry.name).sort();
const fieldCounts = {};
for (const name of collectionNames) {
  const docs = await db.collection(name).find({}).toArray();
  const counts = {};
  for (const field of relevantFields) {
    const count = docs.filter((doc) => {
      const value = doc[field];
      return value !== undefined && value !== null && value !== "" && value !== false;
    }).length;
    if (count > 0) counts[field] = count;
  }
  if (Object.keys(counts).length > 0) fieldCounts[name] = { documents: docs.length, counts };
}
console.log("FIELD_PRESENCE", JSON.stringify(fieldCounts));

const users = await db.collection("users").find({ role: "vendor" }).toArray();
const userRows = [];
for (const user of users) {
  const hasBilling = relevantFields.some(
    (field) => user[field] !== undefined && user[field] !== null && user[field] !== "",
  );
  if (!hasBilling) continue;
  const sub = user.stripeSubscriptionId ? subById.get(user.stripeSubscriptionId) : null;
  const accountCount = await db.collection("account").countDocuments({ userId: user._id });
  const sessionCount = await db.collection("session").countDocuments({ userId: user._id });
  userRows.push({
    userId: user._id.toHexString(),
    role: user.role,
    linkedAuthAccounts: accountCount,
    authSessions: sessionCount,
    stripeCustomerId: user.stripeCustomerId ?? null,
    stripeSubscriptionId: user.stripeSubscriptionId ?? null,
    stripePriceId: user.stripePriceId ?? null,
    stripeCheckoutSessionId: user.stripeCheckoutSessionId ?? null,
    subscriptionPlan: user.subscriptionPlan ?? null,
    subscriptionStatus: user.subscriptionStatus ?? null,
    billingPlanId: user.billingPlanId ?? null,
    billingInterval: user.billingInterval ?? null,
    currentPeriodStart: user.currentPeriodStart ?? null,
    currentPeriodEnd: user.currentPeriodEnd ?? null,
    subscriptionExpiresAt: user.subscriptionExpiresAt ?? null,
    cancelAtPeriodEnd: user.cancelAtPeriodEnd ?? false,
    canceledAt: user.canceledAt ?? null,
    stripeSubscriptionStatus: sub?.status ?? null,
    stripeRecurringInterval:
      sub?.items?.data?.[0]?.price?.recurring?.interval ?? null,
    stripePriceIdLive: sub?.items?.data?.[0]?.price?.id ?? null,
    stripeCancelAtPeriodEnd: sub?.cancel_at_period_end ?? null,
    stripeCanceledAt: sub?.canceled_at ?? null,
    stripeEndedAt: sub?.ended_at ?? null,
    referenceIsStale: Boolean(user.stripeSubscriptionId && !stripeSubIds.has(user.stripeSubscriptionId)),
  });
}
console.log("VENDOR_BILLING_USERS", JSON.stringify(userRows));

const historyCollections = ["stripeEvents", "subscriptionEvents", "transactions"];
const history = {};
for (const name of historyCollections) {
  const docs = await db.collection(name).find({}).toArray();
  history[name] = docs.map((doc) => ({
    id: String(doc._id),
    vendorId: doc.vendorId ?? null,
    type: doc.type ?? null,
    plan: doc.plan ?? null,
    status: doc.status ?? null,
    billingInterval: doc.billingInterval ?? null,
    stripeEventId: doc.stripeEventId ?? null,
    stripeSubscriptionId: doc.stripeSubscriptionId ?? null,
    createdAt: doc.createdAt ?? null,
  }));
}
console.log("BILLING_HISTORY", JSON.stringify(history));

const stripeEventIds = new Set(stripeEvents.map((event) => event.id));
const processedIds = new Set(
  (await db.collection("stripeEvents").find({}).toArray()).map((doc) => String(doc._id)),
);
console.log("STRIPE_EVENT_RECONCILIATION", JSON.stringify({
  stripeEventCount: stripeEvents.length,
  processedEventCount: processedIds.size,
  stripeEventsMissingFromMongo: stripeEvents
    .filter((event) => !processedIds.has(event.id))
    .map((event) => ({ id: event.id, type: event.type, created: event.created })),
  mongoEventsMissingFromStripe: [...processedIds]
    .filter((id) => !stripeEventIds.has(id))
    .map((id) => ({ id })),
  eventTypeCounts: stripeEvents.reduce((acc, event) => {
    acc[event.type] = (acc[event.type] ?? 0) + 1;
    return acc;
  }, {}),
}));

const staleSubscriptionIds = userRows
  .filter((row) => row.referenceIsStale)
  .map((row) => row.stripeSubscriptionId);
console.log("STALE_REFERENCES", JSON.stringify({
  users: staleSubscriptionIds,
  history: historyCollections.flatMap((name) =>
    history[name]
      .filter((row) => row.stripeSubscriptionId && !stripeSubIds.has(row.stripeSubscriptionId))
      .map((row) => ({ collection: name, id: row.id, subscriptionId: row.stripeSubscriptionId })),
  ),
}));

const activeSubscriptions = stripeSubscriptions
  .filter((sub) => ["active", "trialing"].includes(sub.status))
  .map((sub) => ({
    id: sub.id,
    customerId: typeof sub.customer === "string" ? sub.customer : sub.customer?.id,
    priceId: sub.items?.data?.[0]?.price?.id ?? null,
    interval: sub.items?.data?.[0]?.price?.recurring?.interval ?? null,
    vendorId: sub.metadata?.vendorId ?? null,
    plan: sub.metadata?.plan ?? null,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
  }));
console.log("ACTIVE_STRIPE_SUBSCRIPTIONS", JSON.stringify(activeSubscriptions));

await client.close();
