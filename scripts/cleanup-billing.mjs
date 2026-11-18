import "dotenv/config";
import assert from "node:assert/strict";
import { MongoClient, ObjectId } from "mongodb";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const db = client.db(process.env.DB_NAME);

const backupName = `billingCleanupBackup_${new Date().toISOString().replace(/[-:.]/g, "").replace("T", "T")}`;
const backup = db.collection(backupName);

const stripeSubscriptions = await stripe.subscriptions.list({
  status: "all",
  limit: 100,
  expand: ["data.items.data.price"],
});
const stripeSubscriptionIds = new Set(stripeSubscriptions.data.map((sub) => sub.id));

const staleDebugFilter = {
  _id: new ObjectId("6afdd442b040a66ab02744cd"),
  stripeEventId: "evt_debug_mwmcgu6d",
};
const staleDebug = await db.collection("subscriptionEvents").findOne(staleDebugFilter);
const debugVendorExists = staleDebug
  ? Boolean(await db.collection("users").findOne({ _id: new ObjectId(staleDebug.vendorId) }))
  : false;
const debugEventExists = staleDebug
  ? Boolean(await db.collection("stripeEvents").findOne({ _id: staleDebug.stripeEventId }))
  : false;
const debugStripeEventExists = staleDebug
  ? Boolean(await stripe.events.retrieve(staleDebug.stripeEventId).catch(() => null))
  : false;

console.log("CLEANUP_PRECHECK", JSON.stringify({
  backupCollection: backupName,
  staleDebugRecordFound: Boolean(staleDebug),
  debugVendorExists,
  debugEventExists,
  debugStripeEventExists,
}));

assert.equal(Boolean(staleDebug), true, "expected synthetic debug record not found");
assert.equal(debugVendorExists, false, "debug vendor unexpectedly exists; refusing cleanup");
assert.equal(debugEventExists, false, "debug event unexpectedly exists; refusing cleanup");
assert.equal(debugStripeEventExists, false, "debug event unexpectedly exists in Stripe; refusing cleanup");

const usersWithBilling = await db.collection("users").find({
  $or: [
    { stripeSubscriptionId: { $nin: [null, ""] } },
    { stripeCustomerId: { $nin: [null, ""] } },
  ],
}).toArray();
const staleUserRefs = usersWithBilling
  .filter((user) => user.stripeSubscriptionId && !stripeSubscriptionIds.has(user.stripeSubscriptionId))
  .map((user) => ({
    userId: user._id.toHexString(),
    subscriptionId: user.stripeSubscriptionId,
  }));
assert.deepEqual(staleUserRefs, [], "stale user subscription references found; refusing cleanup");
console.log("CLEANUP_STALE_USER_REFS", JSON.stringify(staleUserRefs));

await backup.insertOne({
  kind: "syntheticDebugSubscriptionEvent",
  reason: "Created by local webhook verification; vendor and Stripe event no longer exist.",
  collection: "subscriptionEvents",
  backedUpAt: new Date(),
  original: staleDebug,
});

const deleteResult = await db.collection("subscriptionEvents").deleteOne({
  _id: staleDebug._id,
  stripeEventId: staleDebug.stripeEventId,
});
assert.equal(deleteResult.deletedCount, 1, "expected to delete exactly one debug record");
console.log("CLEANUP_DELETED", JSON.stringify({
  collection: "subscriptionEvents",
  filter: staleDebugFilter,
  deletedCount: deleteResult.deletedCount,
}));

const yearlyUserId = new ObjectId("6afdc7bdea912c1c6e517202");
const yearlyUser = await db.collection("users").findOne({ _id: yearlyUserId, role: "vendor" });
assert.ok(yearlyUser, "yearly vendor not found");
const yearlySubscription = await stripe.subscriptions.retrieve(
  yearlyUser.stripeSubscriptionId,
  { expand: ["items.data.price"] },
);
const stripeCustomerId =
  typeof yearlySubscription.customer === "string"
    ? yearlySubscription.customer
    : yearlySubscription.customer.id;
assert.equal(yearlyUser.stripeCustomerId, stripeCustomerId, "customer mapping mismatch");
assert.equal(yearlySubscription.items.data[0].price.id, yearlyUser.stripePriceId, "price mapping mismatch");
assert.equal(yearlySubscription.items.data[0].price.recurring?.interval, "year", "Stripe interval is not year");

await backup.insertOne({
  kind: "yearlyUserBeforeReconciliation",
  reason: "Legacy webhook processed before interval fields were added.",
  collection: "users",
  backedUpAt: new Date(),
  original: yearlyUser,
});

const periodStart = yearlySubscription.items.data[0].current_period_start;
const periodEnd = yearlySubscription.items.data[0].current_period_end;
const reconcileFilter = {
  _id: yearlyUser._id,
  role: "vendor",
  stripeCustomerId,
  stripeSubscriptionId: yearlySubscription.id,
  stripePriceId: yearlySubscription.items.data[0].price.id,
};
const reconcileResult = await db.collection("users").updateOne(reconcileFilter, {
  $set: {
    billingPlanId: "yearly",
    billingInterval: "year",
    currentPeriodStart: new Date(periodStart * 1000),
    currentPeriodEnd: new Date(periodEnd * 1000),
    subscriptionExpiresAt: new Date(periodEnd * 1000),
    subscriptionStatus: yearlySubscription.status,
    cancelAtPeriodEnd: yearlySubscription.cancel_at_period_end === true,
    canceledAt: yearlySubscription.canceled_at
      ? new Date(yearlySubscription.canceled_at * 1000)
      : yearlySubscription.ended_at
        ? new Date(yearlySubscription.ended_at * 1000)
        : null,
    updatedAt: new Date(),
  },
});
assert.equal(reconcileResult.matchedCount, 1, "yearly reconciliation filter did not match");
console.log("CLEANUP_RECONCILED", JSON.stringify({
  collection: "users",
  userId: yearlyUser._id.toHexString(),
  matchedCount: reconcileResult.matchedCount,
  modifiedCount: reconcileResult.modifiedCount,
  set: {
    billingPlanId: "yearly",
    billingInterval: "year",
    currentPeriodStart: new Date(periodStart * 1000),
    currentPeriodEnd: new Date(periodEnd * 1000),
  },
}));

const after = await db.collection("users").findOne({ _id: yearlyUserId });
console.log("CLEANUP_VERIFY_USER", JSON.stringify({
  billingPlanId: after.billingPlanId,
  billingInterval: after.billingInterval,
  currentPeriodStart: after.currentPeriodStart,
  currentPeriodEnd: after.currentPeriodEnd,
  subscriptionExpiresAt: after.subscriptionExpiresAt,
}));
assert.equal(after.billingInterval, "year");
assert.equal(after.billingPlanId, "yearly");
assert.equal(new Date(after.currentPeriodStart).getTime(), periodStart * 1000);
assert.equal(new Date(after.currentPeriodEnd).getTime(), periodEnd * 1000);

const debugStillExists = await db.collection("subscriptionEvents").findOne(staleDebugFilter);
assert.equal(debugStillExists, null, "debug record still exists after cleanup");
const remainingStaleRefs = (await db.collection("users").find({}).toArray())
  .filter((user) => user.stripeSubscriptionId && !stripeSubscriptionIds.has(user.stripeSubscriptionId))
  .map((user) => user._id.toHexString());
assert.deepEqual(remainingStaleRefs, [], "stale references remain after cleanup");

const counts = {};
for (const name of (await db.listCollections().toArray()).map((entry) => entry.name).sort()) {
  counts[name] = await db.collection(name).countDocuments();
}
console.log("CLEANUP_FINAL_COUNTS", JSON.stringify(counts));

await client.close();
