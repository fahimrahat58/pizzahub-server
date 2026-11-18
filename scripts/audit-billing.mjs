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

const subscriptions = await listAll((startingAfter) =>
  stripe.subscriptions.list({
    status: "all",
    limit: 100,
    starting_after: startingAfter,
    expand: ["data.items.data.price"],
  }),
);
const customers = await listAll((startingAfter) =>
  stripe.customers.list({ limit: 100, starting_after: startingAfter }),
);

const monthly = await stripe.prices.retrieve(process.env.STRIPE_PRICE_ID_MONTHLY);
const yearly = await stripe.prices.retrieve(process.env.STRIPE_PRICE_ID_YEARLY);
const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });

const subSummaries = subscriptions.map((sub) => {
  const item = sub.items?.data?.[0];
  return {
    id: sub.id,
    status: sub.status,
    livemode: sub.livemode,
    customerId: typeof sub.customer === "string" ? sub.customer : sub.customer?.id ?? null,
    priceId: item?.price?.id ?? null,
    recurringInterval: item?.price?.recurring?.interval ?? null,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    cancelAt: sub.cancel_at,
    canceledAt: sub.canceled_at,
    endedAt: sub.ended_at,
    currentPeriodEnd: item?.current_period_end ?? null,
    vendorId: sub.metadata?.vendorId ?? null,
    plan: sub.metadata?.plan ?? null,
  };
});

const customerIds = new Set(customers.map((customer) => customer.id));
const subscriptionIds = new Set(subscriptions.map((sub) => sub.id));
const subById = new Map(subscriptions.map((sub) => [sub.id, sub]));
const subSummaryById = new Map(subSummaries.map((sub) => [sub.id, sub]));

const statuses = {};
for (const sub of subscriptions) statuses[sub.status] = (statuses[sub.status] ?? 0) + 1;

console.log("STRIPE_SUMMARY", JSON.stringify({
  subscriptionCount: subscriptions.length,
  statusCounts: statuses,
  activeOrTrialing: subscriptions.filter((sub) => ["active", "trialing"].includes(sub.status)).length,
  customerCount: customers.length,
  webhookEndpoints: endpoints.data.map((endpoint) => ({
    id: endpoint.id,
    url: endpoint.url,
    status: endpoint.status,
    enabledEvents: endpoint.enabled_events.filter((event) =>
      event.startsWith("checkout.session") ||
      event.startsWith("customer.subscription") ||
      event.startsWith("invoice."),
    ),
  })),
}));

console.log("STRIPE_PRICES", JSON.stringify({
  monthly: {
    id: monthly.id,
    active: monthly.active,
    livemode: monthly.livemode,
    interval: monthly.recurring?.interval ?? null,
    intervalCount: monthly.recurring?.interval_count ?? null,
    amount: monthly.unit_amount,
    currency: monthly.currency,
    product: typeof monthly.product === "string" ? monthly.product : monthly.product?.id,
  },
  yearly: {
    id: yearly.id,
    active: yearly.active,
    livemode: yearly.livemode,
    interval: yearly.recurring?.interval ?? null,
    intervalCount: yearly.recurring?.interval_count ?? null,
    amount: yearly.unit_amount,
    currency: yearly.currency,
    product: typeof yearly.product === "string" ? yearly.product : yearly.product?.id,
  },
}));

console.log("STRIPE_SUBSCRIPTIONS", JSON.stringify(subSummaries));
console.log("STRIPE_CUSTOMER_IDS", JSON.stringify(customers.map((customer) => customer.id)));

const collections = (await db.listCollections().toArray()).map((entry) => entry.name).sort();
const collectionCounts = {};
for (const name of collections) collectionCounts[name] = await db.collection(name).countDocuments();
console.log("MONGO_COLLECTIONS", JSON.stringify(collectionCounts));

const usersWithBilling = await db.collection("users").find({
  $or: [
    { stripeCustomerId: { $nin: [null, ""] } },
    { stripeSubscriptionId: { $nin: [null, ""] } },
    { stripePriceId: { $nin: [null, ""] } },
    { subscriptionPlan: { $in: ["premium", "pro"] } },
    { subscriptionStatus: { $nin: [null, "none"] } },
    { billingPlanId: { $nin: [null, ""] } },
    { billingInterval: { $nin: [null, ""] } },
    { cancelAtPeriodEnd: true },
    { canceledAt: { $ne: null } },
    { currentPeriodStart: { $ne: null } },
    { currentPeriodEnd: { $ne: null } },
    { subscriptionExpiresAt: { $ne: null } },
    { subscriptionEventId: { $nin: [null, ""] } },
    { checkoutEventCreatedAt: { $ne: null } },
    { stripeCheckoutSessionId: { $nin: [null, ""] } },
  ],
}).toArray();

const userSummaries = usersWithBilling.map((user) => {
  const stripeSubId = user.stripeSubscriptionId ?? null;
  return {
    userId: user._id.toHexString(),
    role: user.role,
    stripeCustomerId: user.stripeCustomerId ?? null,
    stripeSubscriptionId: stripeSubId,
    stripePriceId: user.stripePriceId ?? null,
    subscriptionPlan: user.subscriptionPlan ?? null,
    subscriptionStatus: user.subscriptionStatus ?? null,
    billingPlanId: user.billingPlanId ?? null,
    billingInterval: user.billingInterval ?? null,
    currentPeriodStart: user.currentPeriodStart ?? null,
    currentPeriodEnd: user.currentPeriodEnd ?? null,
    subscriptionExpiresAt: user.subscriptionExpiresAt ?? null,
    cancelAtPeriodEnd: user.cancelAtPeriodEnd ?? false,
    canceledAt: user.canceledAt ?? null,
    subscriptionEventId: user.subscriptionEventId ?? null,
    subscriptionEventCreatedAt: user.subscriptionEventCreatedAt ?? null,
    checkoutEventCreatedAt: user.checkoutEventCreatedAt ?? null,
    stripeCheckoutSessionId: user.stripeCheckoutSessionId ?? null,
    stripeSubscriptionExists: stripeSubId ? subscriptionIds.has(stripeSubId) : null,
    stripeCustomerExists: user.stripeCustomerId ? customerIds.has(user.stripeCustomerId) : null,
    stripeLiveSnapshot: stripeSubId ? subSummaryById.get(stripeSubId) ?? null : null,
  };
});

console.log("MONGO_USERS_WITH_BILLING", JSON.stringify(userSummaries));

const staleSubIds = userSummaries
  .filter((user) => user.stripeSubscriptionId && !user.stripeSubscriptionExists)
  .map((user) => user.stripeSubscriptionId);
const staleCustomerIds = userSummaries
  .filter((user) => user.stripeCustomerId && !user.stripeCustomerExists)
  .map((user) => user.stripeCustomerId);

const historyCounts = {};
for (const name of ["stripeEvents", "subscriptionEvents", "transactions"]) {
  const docs = await db.collection(name).find({}).toArray();
  historyCounts[name] = {
    total: docs.length,
    referencingStaleSubscription: docs.filter((doc) =>
      staleSubIds.includes(doc.stripeSubscriptionId ?? doc.subscriptionId ?? null)
    ).length,
    referencingStaleCustomer: docs.filter((doc) =>
      staleCustomerIds.includes(doc.stripeCustomerId ?? doc.customerId ?? null)
    ).length,
    statuses: docs.reduce((acc, doc) => {
      const key = String(doc.status ?? doc.type ?? "none");
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
  };
}
console.log("MONGO_HISTORY_COUNTS", JSON.stringify(historyCounts));
console.log("STALE_SUBSCRIPTION_IDS", JSON.stringify([...new Set(staleSubIds)]));
console.log("STALE_CUSTOMER_IDS", JSON.stringify([...new Set(staleCustomerIds)]));

await client.close();
