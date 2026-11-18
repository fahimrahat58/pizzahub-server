import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";
import Stripe from "stripe";

const AUTH = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const API = `http://localhost:${process.env.PORT ?? 5000}`;
const FRONTEND_URL = (process.env.FRONTEND_URL ?? "http://localhost:3000").replace(/\/$/, "");
const monthlyPriceId = process.env.STRIPE_PRICE_ID_MONTHLY?.trim() ?? "";
const yearlyPriceId = process.env.STRIPE_PRICE_ID_YEARLY?.trim() ?? "";
const suffix = Date.now().toString(36);
const password = "TestPass123!";
const email = (label) => `pizzahub-it-${label}-${suffix}@example.com`;
const imageUrl = "https://images.unsplash.com/photo-1513104890138-7c749659a591?w=800";

const jars = new Map();
const tokens = new Map();
const users = {};

const waitFor = async (url, label) => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // retry
    }
    await delay(500);
  }
  throw new Error(`${label} did not become ready`);
};

const json = async (response) => {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const saveCookies = (actor, response) => {
  const values = new Map();
  for (const part of (jars.get(actor) ?? "").split("; ")) {
    const index = part.indexOf("=");
    if (index > 0) values.set(part.slice(0, index), part.slice(index + 1));
  }
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const part = raw.split(";")[0];
    const index = part.indexOf("=");
    if (index > 0) values.set(part.slice(0, index), part.slice(index + 1));
  }
  jars.set(actor, [...values].map(([key, value]) => `${key}=${value}`).join("; "));
};

const authRequest = async (actor, path, init = {}) => {
  const headers = new Headers(init.headers);
  headers.set("origin", AUTH);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const cookie = jars.get(actor);
  if (cookie) headers.set("cookie", cookie);
  const response = await fetch(`${AUTH}${path}`, {
    ...init,
    headers,
    redirect: "manual",
  });
  saveCookies(actor, response);
  return response;
};

// Better Auth limits sign-up/sign-in to 3 requests per 10 seconds by default.
// Honor its Retry-After header so the test suite does not need a weaker auth
// configuration just to create its four role-specific accounts.
const authRequestWithRateLimitRetry = async (actor, path, init = {}) => {
  let response;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    response = await authRequest(actor, path, init);
    if (response.status !== 429) return response;
    const retryAfter = Number(response.headers.get("X-Retry-After") ?? "11");
    await delay((Number.isFinite(retryAfter) ? retryAfter : 11) * 1000 + 250);
  }
  return response;
};

const signUp = async (actor, role) => {
  const response = await authRequestWithRateLimitRetry(
    actor,
    "/api/auth/sign-up/email",
    {
      method: "POST",
      body: JSON.stringify({
        name: `${actor} user`,
        email: email(actor),
        password,
        role,
      }),
    },
  );
  const body = await json(response);
  assert.equal(response.status, 200, `signup ${actor}: ${JSON.stringify(body)}`);
  const user = body?.user ?? body?.data?.user;
  assert.ok(user?.id, `signup ${actor} returned no user id`);
  users[actor] = user;
  return user;
};

const signIn = async (actor, userEmail) => {
  const response = await authRequestWithRateLimitRetry(
    actor,
    "/api/auth/sign-in/email",
    {
      method: "POST",
      body: JSON.stringify({ email: userEmail, password }),
    },
  );
  const body = await json(response);
  assert.equal(response.status, 200, `signin ${actor}: ${JSON.stringify(body)}`);
};

const fetchToken = async (actor) => {
  const response = await authRequest(actor, "/api/auth/token");
  const body = await json(response);
  assert.equal(response.status, 200, `token ${actor}: ${JSON.stringify(body)}`);
  assert.ok(body?.token, `token ${actor} missing`);
  tokens.set(actor, body.token);
};

const api = async (actor, method, path, body, expected = 200) => {
  const headers = { "content-type": "application/json" };
  if (actor) headers.authorization = `Bearer ${tokens.get(actor)}`;
  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await json(response);
  assert.equal(
    response.status,
    expected,
    `${method} ${path} (${actor ?? "public"}) expected ${expected}, got ${response.status}: ${JSON.stringify(data)}`,
  );
  return data;
};

const pass = (message) => console.log(`PASS  ${message}`);

assert.match(monthlyPriceId, /^price_/, "STRIPE_PRICE_ID_MONTHLY must be a price_... ID");
assert.match(yearlyPriceId, /^price_/, "STRIPE_PRICE_ID_YEARLY must be a price_... ID");
assert.ok(process.env.STRIPE_SECRET_KEY?.trim(), "STRIPE_SECRET_KEY is required for billing tests");
assert.ok(process.env.STRIPE_WEBHOOK_SECRET?.trim(), "STRIPE_WEBHOOK_SECRET is required for billing tests");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const webhookEventIds = [];
const checkoutSessionIds = [];

const subscriptionEvent = (
  eventId,
  { customer, status, cancelAtPeriodEnd, periodEnd, vendorId, type = "customer.subscription.updated" },
) => ({
  id: eventId,
  object: "event",
  api_version: "2025-03-31.basil",
  type,
  created: Math.floor(Date.now() / 1000),
  data: {
    object: {
      id: `sub_it_${suffix}`,
      object: "subscription",
      customer,
      status,
      metadata: { vendorId, plan: "monthly" },
      cancel_at_period_end: cancelAtPeriodEnd,
      items: {
        object: "list",
        data: [
          {
            id: `si_it_${suffix}`,
            object: "subscription_item",
            current_period_end: periodEnd,
          },
        ],
      },
    },
  },
});

const sendWebhook = async (event, { validSignature = true, includeSignature = true } = {}) => {
  const payload = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const secret = (process.env.STRIPE_WEBHOOK_SECRET ?? "").trim();
  const digest = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  const headers = { "content-type": "application/json" };
  if (includeSignature) {
    headers["stripe-signature"] = `t=${timestamp},v1=${validSignature ? digest : "0".repeat(64)}`;
  }
  const response = await fetch(`${API}/api/webhooks/stripe`, {
    method: "POST",
    headers,
    body: payload,
  });
  return { response, data: await json(response) };
};

const client = new MongoClient(process.env.MONGODB_URI);
let cleanupIds = [];

try {
  await waitFor(`${API}/api/health`, "Express API");
  await waitFor(`${AUTH}/api/auth/get-session`, "Next.js app");
  await client.connect();
  const db = client.db(process.env.DB_NAME);
  pass("Both servers are reachable");

  // Role assignment: public signup can never create an admin.
  const customer = await signUp("customer", "customer");
  const vendor = await signUp("vendor", "vendor");
  const adminCandidate = await signUp("admin", "admin");
  assert.equal(customer.role, "customer");
  assert.equal(vendor.role, "vendor");
  assert.equal(adminCandidate.role, "customer", "public admin signup must be downgraded");
  pass("Customer/vendor role selection works; public admin signup is blocked");

  // A protected server-side operation promotes the test admin.
  await db.collection("users").updateOne(
    { _id: new ObjectId(adminCandidate.id) },
    { $set: { role: "admin" } },
  );
  const otherVendor = await signUp("otherVendor", "vendor");
  cleanupIds = [customer.id, vendor.id, adminCandidate.id, otherVendor.id];

  const rawVendor = await db.collection("users").findOne({ _id: new ObjectId(vendor.id) });
  assert.equal(rawVendor?.businessName ?? null, null);
  assert.equal(
    await db.collection("restaurants").countDocuments({ vendorId: vendor.id }),
    0,
    "signup must not create a restaurant",
  );
  pass("Vendor signup stores account details only and creates no restaurant");

  for (const actor of ["customer", "vendor", "admin", "otherVendor"]) {
    await fetchToken(actor);
  }
  pass("JWT tokens issued and accepted by the Express API");

  await signIn("login", email("customer"));
  await fetchToken("login");
  await api("login", "GET", "/api/users/me");
  pass("Email/password login works");

  const restaurant = await api("vendor", "PUT", "/api/restaurants/mine", {
    name: "Test Kitchen",
    description: "A temporary kitchen used for integration tests",
    image: imageUrl,
    address: "123 Test Street, Pizza City",
    phone: "+15551234567",
    openingHours: "10:00-22:00",
  });
  assert.equal(restaurant.restaurant.name, "Test Kitchen");
  pass("Vendor restaurant profile saved");

  const menuPayload = (name, isActive = true) => ({
    name,
    description: `A test pizza called ${name} with a full description`,
    category: "Pizza",
    price: 10 + name.length,
    ingredients: ["tomato", "cheese", "basil"],
    image: imageUrl,
    isActive,
  });

  const itemIds = [];
  for (let index = 1; index <= 3; index += 1) {
    const data = await api(
      "vendor",
      "POST",
      "/api/menu/vendor",
      menuPayload(`Integration Pizza ${index}`),
      201,
    );
    assert.equal(data.item.approvalStatus, "approved");
    assert.equal(data.item.isActive, true);
    assert.equal(data.item.restaurantId, restaurant.restaurant.id);
    assert.equal(data.item.restaurant?.id, restaurant.restaurant.id);
    assert.equal(data.item.restaurant?.name, restaurant.restaurant.name);
    itemIds.push(data.item.id);
  }
  pass("Vendor items publish immediately with the sole restaurant inferred");

  const blockedCreate = await api(
    "vendor",
    "POST",
    "/api/menu/vendor",
    menuPayload("Integration Pizza Over Limit"),
    409,
  );
  assert.match(blockedCreate.message, /maximum of 3 active menu items/i);
  const fourth = await api(
    "vendor",
    "POST",
    "/api/menu/vendor",
    menuPayload("Integration Pizza 4", false),
    201,
  );
  assert.equal(fourth.item.approvalStatus, "approved");
  assert.equal(fourth.item.isActive, false);
  assert.equal(fourth.item.restaurantId, restaurant.restaurant.id);
  itemIds.push(fourth.item.id);
  pass("Free plan blocks a fourth active item at creation; unpublished items are allowed");

  await api(
    "otherVendor",
    "PATCH",
    `/api/menu/vendor/${itemIds[0]}`,
    { name: "Stolen Pizza" },
    404,
  );
  await api("otherVendor", "DELETE", `/api/menu/vendor/${itemIds[0]}`, undefined, 404);
  pass("A vendor cannot edit or delete another vendor's menu items");

  // --- Restaurant association rules ----------------------------------------
  const secondRestaurant = await api(
    "vendor",
    "POST",
    "/api/restaurants/mine",
    {
      name: "Test Kitchen Two",
      description: "A second temporary kitchen used for integration tests",
      image: imageUrl,
      address: "456 Test Avenue, Pizza City",
      phone: "+15557654321",
      openingHours: "11:00-23:00",
    },
    201,
  );
  const foreignRestaurant = await api(
    "otherVendor",
    "POST",
    "/api/restaurants/mine",
    {
      name: "Foreign Kitchen",
      description: "A restaurant owned by another vendor for integration tests",
      image: imageUrl,
      address: "789 Foreign Road, Pizza City",
      phone: "+15559876543",
    },
    201,
  );
  const myRestaurants = await api("vendor", "GET", "/api/restaurants/mine");
  assert.equal(myRestaurants.restaurants.length, 2);
  assert.equal(myRestaurants.restaurant.id, restaurant.restaurant.id);
  pass("GET /api/restaurants/mine lists every owned restaurant plus the legacy first restaurant");

  const assignedItem = await api(
    "vendor",
    "POST",
    "/api/menu/vendor",
    {
      ...menuPayload("Integration Pizza Second Location", false),
      restaurantId: secondRestaurant.restaurant.id,
    },
    201,
  );
  assert.equal(assignedItem.item.restaurantId, secondRestaurant.restaurant.id);
  assert.equal(assignedItem.item.restaurant?.id, secondRestaurant.restaurant.id);
  assert.equal(assignedItem.item.approvalStatus, "approved");
  await api(
    "vendor",
    "POST",
    "/api/menu/vendor",
    menuPayload("Integration Pizza No Selection", false),
    400,
  );
  await api(
    "vendor",
    "POST",
    "/api/menu/vendor",
    {
      ...menuPayload("Integration Pizza Bad Restaurant", false),
      restaurantId: new ObjectId().toHexString(),
    },
    400,
  );
  await api(
    "vendor",
    "POST",
    "/api/menu/vendor",
    {
      ...menuPayload("Integration Pizza Foreign Restaurant", false),
      restaurantId: foreignRestaurant.restaurant.id,
    },
    400,
  );
  pass("With multiple restaurants an owned ID is required; missing, invalid, and foreign IDs are rejected");

  // --- Admin visibility, unpublish/republish, and takedown ------------------
  const adminAll = await api("admin", "GET", "/api/menu/admin/all?limit=100");
  for (const id of itemIds) {
    const row = adminAll.items.find((item) => item.id === id);
    assert.ok(row, `admin all item ${id}`);
    assert.equal(row.approvalStatus, "approved");
  }
  await api("vendor", "GET", "/api/menu/admin/all", undefined, 403);
  await api("customer", "GET", "/api/menu/admin/all", undefined, 403);
  pass("Admin can list every menu item; non-admins cannot use admin menu routes");

  const publicMenu = await api(null, "GET", "/api/menu?limit=100");
  for (const id of itemIds.slice(0, 3)) {
    assert.ok(publicMenu.items.some((item) => item.id === id), `public item ${id}`);
  }
  assert.ok(!publicMenu.items.some((item) => item.id === itemIds[3]));
  const firstPublic = publicMenu.items.find((item) => item.id === itemIds[0]);
  assert.equal(firstPublic.restaurantId, restaurant.restaurant.id);
  assert.equal(firstPublic.restaurant?.id, restaurant.restaurant.id);
  assert.equal(firstPublic.restaurant?.name, restaurant.restaurant.name);
  await api(null, "GET", `/api/menu/${itemIds[3]}`, undefined, 404);
  pass("Public browse exposes only approved active items with a restaurant summary");

  const unpublished = await api(
    "vendor",
    "PATCH",
    `/api/menu/vendor/${itemIds[2]}/active`,
    { isActive: false },
  );
  assert.equal(unpublished.item.isActive, false);
  assert.equal(unpublished.message, "Pizza unpublished");
  const afterUnpublish = await api(null, "GET", "/api/menu?limit=100");
  assert.ok(!afterUnpublish.items.some((item) => item.id === itemIds[2]));
  await api(null, "GET", `/api/menu/${itemIds[2]}`, undefined, 404);
  const republished = await api(
    "vendor",
    "PATCH",
    `/api/menu/vendor/${itemIds[2]}/active`,
    { isActive: true },
  );
  assert.equal(republished.item.isActive, true);
  assert.equal(republished.message, "Pizza published");
  const afterRepublish = await api(null, "GET", "/api/menu?limit=100");
  assert.ok(afterRepublish.items.some((item) => item.id === itemIds[2]));
  pass("Vendor unpublish hides an item from browse/detail and republish restores it");

  const blockedUpdate = await api(
    "vendor",
    "PATCH",
    `/api/menu/vendor/${itemIds[3]}`,
    { isActive: true },
    409,
  );
  assert.match(blockedUpdate.message, /maximum of 3 active menu items/i);
  pass("Vendor cannot bypass the free active limit through the edit endpoint");

  const hiddenByAdmin = await api(
    "admin",
    "PATCH",
    `/api/menu/admin/${itemIds[1]}/approval`,
    { approvalStatus: "rejected" },
  );
  assert.equal(hiddenByAdmin.item.approvalStatus, "rejected");
  assert.equal(hiddenByAdmin.item.isActive, false);
  assert.equal(hiddenByAdmin.message, "Pizza hidden");
  const afterAdminHide = await api(null, "GET", "/api/menu?limit=100");
  assert.ok(!afterAdminHide.items.some((item) => item.id === itemIds[1]));
  await api(null, "GET", `/api/menu/${itemIds[1]}`, undefined, 404);
  const restoredByAdmin = await api(
    "admin",
    "PATCH",
    `/api/menu/admin/${itemIds[1]}/approval`,
    { approvalStatus: "approved", isActive: true },
  );
  assert.equal(restoredByAdmin.item.approvalStatus, "approved");
  assert.equal(restoredByAdmin.item.isActive, true);
  assert.equal(restoredByAdmin.message, "Pizza restored");
  const afterAdminRestore = await api(null, "GET", "/api/menu?limit=100");
  assert.ok(afterAdminRestore.items.some((item) => item.id === itemIds[1]));
  pass("Admin approval route hides and restores items without a pending-creation step");

  // --- Safe restaurant deletion for a restaurant with no history ------------
  const restaurantDelete = await api(
    "vendor",
    "DELETE",
    `/api/restaurants/mine/${secondRestaurant.restaurant.id}`,
  );
  assert.ok(restaurantDelete.deletedMenuItems >= 1);
  const remainingRestaurants = await api("vendor", "GET", "/api/restaurants/mine");
  assert.equal(remainingRestaurants.restaurants.length, 1);
  assert.equal(remainingRestaurants.restaurant.id, restaurant.restaurant.id);
  assert.equal(
    await db.collection("menuItems").countDocuments({ _id: new ObjectId(assignedItem.item.id) }),
    0,
    "items of a deleted unhistorical restaurant must be removed",
  );
  pass("Deleting an unhistorical restaurant also removes its menu items");

  // --- Vendor Premium subscriptions (Stripe TEST mode) --------------------
  await api(null, "GET", "/api/subscriptions/status", undefined, 401);
  await api("customer", "GET", "/api/subscriptions/status", undefined, 403);
  await api("admin", "GET", "/api/subscriptions/status", undefined, 403);
  const initialStatus = await api("vendor", "GET", "/api/subscriptions/status");
  assert.equal(initialStatus.subscription.plan, "free");
  assert.equal(initialStatus.subscription.isPremium, false);
  assert.equal(initialStatus.subscription.activeItemLimit, 3);
  pass("Subscription endpoints are authenticated and vendor-only");

  // Ordinary profile updates must never be able to grant Premium.
  await api("vendor", "PATCH", "/api/users/me", {
    name: "vendor user",
    subscriptionPlan: "premium",
    stripeSubscriptionId: "sub_illegal",
  });
  const afterProfile = await api("vendor", "GET", "/api/subscriptions/status");
  assert.equal(afterProfile.subscription.plan, "free");
  assert.equal(afterProfile.subscription.stripeSubscriptionId, null);
  pass("Profile API cannot set subscription/billing fields");

  const planResponse = await api("vendor", "GET", "/api/subscriptions/plans");
  assert.equal(planResponse.configured, true, planResponse.issue ?? "Stripe not configured");
  const monthlyPlan = planResponse.plans.find((entry) => entry.id === "monthly");
  const yearlyPlan = planResponse.plans.find((entry) => entry.id === "yearly");
  assert.ok(monthlyPlan && monthlyPlan.amount > 0);
  assert.ok(yearlyPlan && yearlyPlan.amount > 0);
  pass("Plan prices are fetched server-side from Stripe");

  await api("vendor", "POST", "/api/subscriptions/create-checkout-session", { plan: "pro" }, 400);
  await api(
    "vendor",
    "POST",
    "/api/subscriptions/create-checkout-session",
    { plan: "monthly", priceId: "price_attacker" },
    400,
  );
  pass("Checkout rejects invalid plans and any frontend-supplied Price ID");

  const checkout = await api("vendor", "POST", "/api/subscriptions/create-checkout-session", {
    plan: "monthly",
  });
  checkoutSessionIds.push(checkout.sessionId);
  assert.match(checkout.url, /^https:\/\/checkout\.stripe\.com\//);
  const stripeSession = await stripe.checkout.sessions.retrieve(checkout.sessionId, {
    expand: ["line_items"],
  });
  assert.equal(stripeSession.mode, "subscription");
  assert.equal(stripeSession.line_items?.data?.[0]?.price?.id, monthlyPriceId);
  assert.equal(stripeSession.metadata?.vendorId, vendor.id);
  assert.equal(stripeSession.metadata?.plan, "monthly");
  assert.match(
    stripeSession.success_url ?? "",
    /\/dashboard\/vendor\/subscription\/success\?session_id=\{CHECKOUT_SESSION_ID\}$/,
  );
  assert.equal(
    stripeSession.cancel_url,
    `${FRONTEND_URL}/dashboard/vendor/subscription/cancel`,
  );
  const stripeCustomerId =
    typeof stripeSession.customer === "string" ? stripeSession.customer : stripeSession.customer?.id;
  assert.ok(stripeCustomerId, "Checkout session has no Stripe customer");
  const customerStatus = await api("vendor", "GET", "/api/subscriptions/status");
  assert.equal(customerStatus.subscription.stripeCustomerId, stripeCustomerId);
  pass("Stripe checkout uses the server Price ID, vendor metadata, and Stripe-controlled URLs");

  const yearlyCheckout = await api("vendor", "POST", "/api/subscriptions/create-checkout-session", {
    plan: "yearly",
  });
  checkoutSessionIds.push(yearlyCheckout.sessionId);
  const yearlySession = await stripe.checkout.sessions.retrieve(yearlyCheckout.sessionId, {
    expand: ["line_items"],
  });
  assert.equal(yearlySession.line_items?.data?.[0]?.price?.id, yearlyPriceId);
  assert.equal(yearlySession.metadata?.plan, "yearly");
  pass("Yearly checkout selects the yearly Price ID from the server environment");

  const portal = await api("vendor", "POST", "/api/subscriptions/create-portal-session");
  assert.match(portal.url, /^https:\/\/billing\.stripe\.com\//);
  pass("Stripe billing portal session is created for the vendor");

  const futurePeriod = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
  const invalidEventId = `evt_it_invalid_${suffix}`;
  const invalidEvent = subscriptionEvent(invalidEventId, {
    customer: stripeCustomerId,
    status: "active",
    cancelAtPeriodEnd: false,
    periodEnd: futurePeriod,
    vendorId: vendor.id,
  });
  assert.equal((await sendWebhook(invalidEvent, { validSignature: false })).response.status, 400);
  assert.equal((await sendWebhook(invalidEvent, { includeSignature: false })).response.status, 400);
  pass("Stripe webhooks with invalid or missing signatures are rejected");

  const checkoutEventId = `evt_it_checkout_${suffix}`;
  webhookEventIds.push(checkoutEventId);
  const checkoutCompleted = await sendWebhook({
    id: checkoutEventId,
    object: "event",
    type: "checkout.session.completed",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: checkout.sessionId,
        object: "checkout.session",
        client_reference_id: vendor.id,
        metadata: { vendorId: vendor.id, plan: "monthly" },
        subscription: null,
      },
    },
  });
  assert.equal(checkoutCompleted.response.status, 200, JSON.stringify(checkoutCompleted.data));
  pass("Verified checkout.session.completed events are accepted");

  const activationEventId = `evt_it_activate_${suffix}`;
  webhookEventIds.push(activationEventId);
  const activationEvent = subscriptionEvent(activationEventId, {
    customer: stripeCustomerId,
    status: "active",
    cancelAtPeriodEnd: false,
    periodEnd: futurePeriod,
    vendorId: vendor.id,
    type: "customer.subscription.created",
  });
  const activation = await sendWebhook(activationEvent);
  assert.equal(activation.response.status, 200, JSON.stringify(activation.data));
  const premiumStatus = await api("vendor", "GET", "/api/subscriptions/status");
  assert.equal(premiumStatus.subscription.plan, "premium");
  assert.equal(premiumStatus.subscription.isPremium, true);
  assert.equal(premiumStatus.subscription.stripeSubscriptionId, activationEvent.data.object.id);
  assert.equal(
    new Date(premiumStatus.subscription.subscriptionExpiresAt).getTime(),
    futurePeriod * 1000,
  );
  pass("Verified subscription.created webhook activates Premium from trusted MongoDB state");

  const duplicate = await sendWebhook(activationEvent);
  assert.equal(duplicate.data.duplicate, true);
  const history = await api("admin", "GET", `/api/users/admin/subscriptions/${vendor.id}/history`);
  assert.equal(history.events.filter((entry) => entry.stripeEventId === activationEventId).length, 1);
  pass("Duplicate Stripe event deliveries are idempotent");

  const billingOverview = await api(
    "admin",
    "GET",
    `/api/users/admin/subscriptions?search=${encodeURIComponent(email("vendor"))}`,
  );
  const billingRow = billingOverview.vendors.find((entry) => entry.id === vendor.id);
  assert.ok(billingRow);
  assert.equal(billingRow.subscriptionPlan, "premium");
  assert.equal(billingRow.stripeCustomerId, stripeCustomerId);
  assert.equal(billingRow.stripeSubscriptionId, activationEvent.data.object.id);
  assert.ok(billingRow.subscriptionExpiresAt);
  pass("Admin sees read-only billing fields and webhook-derived history");

  // The status endpoint has no vendorId input; even if one is supplied it must
  // continue to return only the authenticated vendor's own record.
  const forgedVendorId = new ObjectId().toHexString();
  const scopedStatus = await api(
    "vendor",
    "GET",
    `/api/subscriptions/status?vendorId=${forgedVendorId}`,
  );
  assert.equal(scopedStatus.subscription.stripeCustomerId, stripeCustomerId);
  assert.equal(scopedStatus.subscription.stripeSubscriptionId, activationEvent.data.object.id);
  await api("vendor", "GET", "/api/users/admin/subscriptions", undefined, 403);
  await api(
    "vendor",
    "GET",
    `/api/users/admin/subscriptions/${forgedVendorId}/history`,
    undefined,
    403,
  );
  pass("Vendors cannot read another vendor's billing data or admin billing views");

  await api(
    "vendor",
    "POST",
    "/api/subscriptions/create-checkout-session",
    { plan: "yearly" },
    409,
  );
  pass("Duplicate active subscriptions are blocked");

  const fourthActive = await api(
    "vendor",
    "PATCH",
    `/api/menu/vendor/${itemIds[3]}/active`,
    { isActive: true },
  );
  assert.equal(fourthActive.item.isActive, true);
  pass("Premium vendors can activate more than three menu items");

  const extraItem = await api(
    "vendor",
    "POST",
    "/api/menu/vendor",
    {
      name: "Integration Pizza 5",
      description: "A fifth test pizza used to verify the restored free limit",
      category: "Pizza",
      price: 15,
      ingredients: ["tomato", "cheese", "basil"],
      image: imageUrl,
      isActive: true,
    },
    201,
  );
  assert.equal(extraItem.item.approvalStatus, "approved");
  assert.equal(extraItem.item.isActive, true);
  itemIds.push(extraItem.item.id);
  await api("vendor", "PATCH", `/api/menu/vendor/${extraItem.item.id}/active`, {
    isActive: false,
  });

  const cancelEventId = `evt_it_cancel_at_period_end_${suffix}`;
  webhookEventIds.push(cancelEventId);
  await sendWebhook(
    subscriptionEvent(cancelEventId, {
      customer: stripeCustomerId,
      status: "active",
      cancelAtPeriodEnd: true,
      periodEnd: futurePeriod,
      vendorId: vendor.id,
    }),
  );
  const cancelScheduled = await api("vendor", "GET", "/api/subscriptions/status");
  assert.equal(cancelScheduled.subscription.isPremium, true);
  assert.equal(cancelScheduled.subscription.cancelAtPeriodEnd, true);
  pass("cancel_at_period_end keeps Premium until the period ends");

  // Simulate time passing past the stored period end without touching the API.
  await db.collection("users").updateOne(
    { _id: new ObjectId(vendor.id) },
    { $set: { subscriptionExpiresAt: new Date(Date.now() - 60_000) } },
  );
  const expired = await api("vendor", "GET", "/api/subscriptions/status");
  assert.equal(expired.subscription.plan, "free");
  assert.equal(expired.subscription.isPremium, false);
  const blockedAdminRestore = await api(
    "admin",
    "PATCH",
    `/api/menu/admin/${extraItem.item.id}/approval`,
    { approvalStatus: "approved", isActive: true },
    409,
  );
  assert.match(blockedAdminRestore.message, /maximum of 3 active menu items/i);
  const stillListed = await api(null, "GET", "/api/menu?limit=100");
  assert.ok(stillListed.items.some((entry) => entry.id === itemIds[3]));
  pass("Expired subscription loses Premium; admin restore also respects the free limit");

  const pastDueEventId = `evt_it_past_due_${suffix}`;
  webhookEventIds.push(pastDueEventId);
  await sendWebhook(
    subscriptionEvent(pastDueEventId, {
      customer: stripeCustomerId,
      status: "past_due",
      cancelAtPeriodEnd: false,
      periodEnd: futurePeriod,
      vendorId: vendor.id,
    }),
  );
  const pastDue = await api("vendor", "GET", "/api/subscriptions/status");
  assert.equal(pastDue.subscription.status, "past_due");
  assert.equal(pastDue.subscription.plan, "free");
  pass("Failed renewal (past_due) removes Premium until Stripe restores it");

  const deletedEventId = `evt_it_deleted_${suffix}`;
  webhookEventIds.push(deletedEventId);
  const deleted = await sendWebhook(
    subscriptionEvent(deletedEventId, {
      customer: stripeCustomerId,
      status: "canceled",
      cancelAtPeriodEnd: false,
      periodEnd: futurePeriod,
      vendorId: vendor.id,
      type: "customer.subscription.deleted",
    }),
  );
  assert.equal(deleted.response.status, 200, JSON.stringify(deleted.data));
  const canceledStatus = await api("vendor", "GET", "/api/subscriptions/status");
  assert.equal(canceledStatus.subscription.status, "canceled");
  assert.equal(canceledStatus.subscription.plan, "free");
  pass("Verified subscription.deleted webhook deactivates Premium");

  await api("customer", "POST", "/api/favorites", { menuItemId: itemIds[0] }, 201);
  const favoriteIds = await api("customer", "GET", "/api/favorites/ids");
  assert.ok(favoriteIds.ids.includes(itemIds[0]));
  await api("customer", "DELETE", `/api/favorites/${itemIds[0]}`);
  const cleared = await api("customer", "GET", "/api/favorites/ids");
  assert.ok(!cleared.ids.includes(itemIds[0]));
  pass("Favorites add, list, and remove work");

  const deliveryDate = new Date().toISOString().slice(0, 10);
  const orderPayload = {
    menuItemId: itemIds[0],
    quantity: 2,
    deliveryAddress: "42 Pizza Lane, Delivery City",
    deliveryDate,
    message: "Extra napkins please",
  };
  const created = await api("customer", "POST", "/api/orders", orderPayload, 201);
  const order = created.order;
  assert.equal(order.status, "pending");
  await api("customer", "POST", "/api/orders", orderPayload, 409);
  pass("Order creation works and blocks duplicate active orders");

  const vendorOrders = await api("vendor", "GET", "/api/orders/vendor?limit=100");
  assert.ok(vendorOrders.orders.some((entry) => entry.id === order.id));
  pass("Vendor can see incoming orders");

  const transitions = [
    ["PATCH", `/api/orders/${order.id}/accept`, undefined, "accepted"],
    ["PATCH", `/api/orders/${order.id}/status`, { status: "preparing" }, "preparing"],
    ["PATCH", `/api/orders/${order.id}/status`, { status: "out_for_delivery" }, "out_for_delivery"],
    ["PATCH", `/api/orders/${order.id}/status`, { status: "delivered" }, "delivered"],
  ];
  let previousLength = order.timeline.length;
  for (const [method, path, body, expectedStatus] of transitions) {
    const result = await api("vendor", method, path, body);
    assert.equal(result.order.status, expectedStatus);
    assert.equal(result.order.timeline.length, previousLength + 1);
    previousLength = result.order.timeline.length;
  }
  pass("Order accept/status transitions append timeline entries");

  const repeat = await api("customer", "POST", "/api/orders", orderPayload, 201);
  await api("customer", "PATCH", `/api/orders/${repeat.order.id}/cancel`);
  pass("Delivered orders release the active-order slot");

  await api(
    "customer",
    "POST",
    "/api/reviews",
    {
      orderId: order.id,
      menuItemId: itemIds[0],
      rating: 5,
      comment: "Delicious integration pizza",
    },
    201,
  );
  const reviews = await api(null, "GET", `/api/reviews/${itemIds[0]}`);
  assert.ok(reviews.reviews.some((review) => review.comment === "Delicious integration pizza"));
  pass("Customer can review a delivered pizza");

  const adminDeleted = await api(
    "admin",
    "DELETE",
    `/api/menu/admin/${extraItem.item.id}`,
  );
  assert.equal(adminDeleted.message, "Pizza deleted by administrator");
  const afterAdminDelete = await api("admin", "GET", "/api/menu/admin/all?limit=100");
  assert.ok(!afterAdminDelete.items.some((entry) => entry.id === extraItem.item.id));
  assert.equal(
    await db.collection("menuItems").countDocuments({ _id: new ObjectId(extraItem.item.id) }),
    0,
  );
  assert.ok(
    await db.collection("orders").findOne({ _id: new ObjectId(order.id) }),
    "admin menu deletion must not remove order snapshots",
  );
  pass("Admin can delete a menu item while preserving historical orders");

  const blockedRestaurantDelete = await api(
    "vendor",
    "DELETE",
    "/api/restaurants/mine",
    undefined,
    409,
  );
  assert.match(blockedRestaurantDelete.message, /order or review history/i);
  const remainingRestaurant = await api("vendor", "GET", "/api/restaurants/mine");
  assert.equal(remainingRestaurant.restaurant.id, restaurant.restaurant.id);
  const persistedOrder = await db.collection("orders").findOne({ _id: new ObjectId(order.id) });
  assert.ok(persistedOrder, "order history must survive a blocked restaurant deletion");
  const preservedItems = await db.collection("menuItems").find({ vendorId: vendor.id }).toArray();
  assert.ok(
    preservedItems.some((entry) => entry._id.equals(new ObjectId(itemIds[0]))),
    "menu items with history must survive a blocked restaurant deletion",
  );
  pass("Restaurant deletion is rejected when items have history; orders and items are preserved");

  const stats = await api("admin", "GET", "/api/admin/stats");
  assert.ok(stats.stats.totalUsers >= 4);
  assert.ok(stats.stats.pendingMenuItems >= 0);
  pass("Admin stats endpoint returns platform data");

  const userSearch = await api(
    "admin",
    "GET",
    `/api/users/admin?search=${encodeURIComponent(email("vendor"))}`,
  );
  assert.ok(userSearch.users.some((entry) => entry.id === vendor.id));
  await api("admin", "PATCH", `/api/users/admin/${vendor.id}/role`, { role: "customer" });
  await api("admin", "PATCH", `/api/users/admin/${vendor.id}/role`, { role: "vendor" });
  pass("Admin can search users and change roles");

  await api("admin", "PATCH", `/api/users/admin/${customer.id}/block`, { isBlocked: true });
  await api("customer", "GET", "/api/orders/my", undefined, 403);
  await api("admin", "PATCH", `/api/users/admin/${customer.id}/block`, { isBlocked: false });
  await api("customer", "GET", "/api/orders/my");
  pass("Blocked users are rejected by the API and can be unblocked");

  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const upload = await api(null, "POST", "/api/uploads/image", {
    dataUrl: `data:image/png;base64,${png}`,
    mime: "image/png",
  });
  assert.match(upload.url, /^https?:\/\//);
  await api(
    null,
    "POST",
    "/api/uploads/image",
    { dataUrl: "not-an-image", mime: "image/png" },
    400,
  );
  pass("ImgBB upload works server-side and rejects invalid images");

  console.log("\nAll integration checks passed.");
} finally {
  if (cleanupIds.length) {
    const objectIds = cleanupIds.map((id) => new ObjectId(id));
    const db = client.db(process.env.DB_NAME);
    await Promise.all([
      db.collection("users").deleteMany({ _id: { $in: objectIds } }),
      db.collection("session").deleteMany({ userId: { $in: objectIds } }),
      db.collection("account").deleteMany({ userId: { $in: objectIds } }),
      db.collection("restaurants").deleteMany({ vendorId: { $in: cleanupIds } }),
      db.collection("menuItems").deleteMany({ vendorId: { $in: cleanupIds } }),
      db.collection("orders").deleteMany({
        $or: [
          { customerId: { $in: cleanupIds } },
          { vendorId: { $in: cleanupIds } },
        ],
      }),
      db.collection("favorites").deleteMany({ customerId: { $in: cleanupIds } }),
      db.collection("reviews").deleteMany({ customerId: { $in: cleanupIds } }),
      db.collection("stripeEvents").deleteMany({ _id: { $in: webhookEventIds } }),
      db.collection("subscriptionEvents").deleteMany({
        stripeEventId: { $in: webhookEventIds },
      }),
    ]);
    console.log("Test data cleaned up.");
  }
  for (const sessionId of checkoutSessionIds) {
    try {
      await stripe.checkout.sessions.expire(sessionId);
    } catch {
      // Test-mode sessions can already be expired or completed by Stripe.
    }
  }
  await client.close();
}
