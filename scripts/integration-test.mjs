import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import "dotenv/config";
import { symmetricDecrypt } from "better-auth/crypto";
import { SignJWT, decodeJwt, decodeProtectedHeader, importJWK } from "jose";
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
const secondImageUrl = "https://images.unsplash.com/photo-1574071318508-1cdbab80d002?w=800";

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
        image: imageUrl,
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

const rawProtected = async (token, path = "/api/test/protected") => {
  const response = await fetch(`${API}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: response.status, data: await json(response) };
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
  {
    customer,
    status,
    cancelAtPeriodEnd,
    periodEnd,
    vendorId,
    plan = "monthly",
    priceId = monthlyPriceId,
    subscriptionId = `sub_it_${suffix}`,
    created = Math.floor(Date.now() / 1000),
    type = "customer.subscription.updated",
  },
) => ({
  id: eventId,
  object: "event",
  api_version: "2025-03-31.basil",
  type,
  created,
  data: {
    object: {
      id: subscriptionId,
      object: "subscription",
      customer,
      status,
      metadata: { vendorId, plan },
      cancel_at_period_end: cancelAtPeriodEnd,
      items: {
        object: "list",
        data: [
          {
            id: `si_it_${suffix}`,
            object: "subscription_item",
            current_period_end: periodEnd,
            price: { id: priceId },
          },
        ],
      },
    },
  },
});

const invoiceEvent = (
  eventId,
  { customer, subscription, paid = true, amount = 1500, created = Math.floor(Date.now() / 1000) },
) => ({
  id: eventId,
  object: "event",
  api_version: "2025-03-31.basil",
  type: paid ? "invoice.paid" : "invoice.payment_failed",
  created,
  data: {
    object: {
      id: `in_it_${eventId}`,
      object: "invoice",
      customer,
      currency: "usd",
      amount_paid: paid ? amount : 0,
      amount_due: paid ? 0 : amount,
      status: paid ? "paid" : "open",
      parent: {
        subscription_details: {
          subscription,
        },
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

  for (const weakPassword of ["Ab1", "lowercase", "UPPERCASE"]) {
    const weak = await authRequestWithRateLimitRetry("weak", "/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({
        name: "Weak Password User",
        email: email(`weak-${weakPassword}`),
        password: weakPassword,
        role: "customer",
      }),
    });
    assert.equal(weak.status, 400, `weak password ${weakPassword} must be rejected server-side`);
  }
  pass("Server rejects short and single-case passwords");

  const rawVendor = await db.collection("users").findOne({ _id: new ObjectId(vendor.id) });
  assert.equal(rawVendor?.image, imageUrl, "signup must persist the optional profile image");
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

  const validToken = tokens.get("customer");
  assert.equal((await rawProtected(null)).status, 401);
  assert.equal((await rawProtected("not-a-jwt")).status, 401);
  pass("Protected routes reject missing and malformed bearer tokens");

  const tokenParts = validToken.split(".");
  const originalClaims = JSON.parse(
    Buffer.from(tokenParts[1], "base64url").toString("utf8"),
  );
  const tamperedClaims = Buffer.from(
    JSON.stringify({ ...originalClaims, sub: new ObjectId().toHexString() }),
  ).toString("base64url");
  const tamperedToken = `${tokenParts[0]}.${tamperedClaims}.${tokenParts[2]}`;
  assert.equal((await rawProtected(tamperedToken)).status, 401);

  const tokenHeader = decodeProtectedHeader(validToken);
  const tokenClaims = decodeJwt(validToken);
  assert.ok(tokenHeader.alg && tokenHeader.kid, "issued JWT must carry alg and kid");
  const jwkDoc = await db.collection("jwks").findOne({
    $or: [
      { id: tokenHeader.kid },
      { _id: tokenHeader.kid },
      { _id: new ObjectId(tokenHeader.kid) },
    ],
  });
  assert.ok(jwkDoc?.privateKey, "JWKS signing key was not persisted");
  const privateWebKey = await symmetricDecrypt({
    key: process.env.BETTER_AUTH_SECRET,
    data: JSON.parse(jwkDoc.privateKey),
  });
  const signingKey = await importJWK(JSON.parse(privateWebKey), tokenHeader.alg);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiredToken = await new SignJWT({ sessionId: tokenClaims.sessionId })
    .setProtectedHeader({ alg: tokenHeader.alg, kid: tokenHeader.kid })
    .setSubject(String(tokenClaims.sub))
    .setIssuer(String(tokenClaims.iss))
    .setAudience(String(tokenClaims.aud))
    .setIssuedAt(nowSeconds - 3600)
    .setExpirationTime(nowSeconds - 60)
    .sign(signingKey);
  assert.equal((await rawProtected(expiredToken)).status, 401);

  const wrongIssuerToken = await new SignJWT({ sessionId: tokenClaims.sessionId })
    .setProtectedHeader({ alg: tokenHeader.alg, kid: tokenHeader.kid })
    .setSubject(String(tokenClaims.sub))
    .setIssuer(`${AUTH}-wrong`)
    .setAudience(String(tokenClaims.aud))
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + 300)
    .sign(signingKey);
  assert.equal((await rawProtected(wrongIssuerToken)).status, 401);
  pass("Tampered, expired, and wrong-issuer JWTs are rejected");

  const sessionId = String(tokenClaims.sessionId ?? "");
  assert.match(sessionId, /^[a-fA-F0-9]{24}$/, "JWT must carry the Better Auth session id");
  const sessionDoc = await db.collection("session").findOne({
    $or: [
      { _id: new ObjectId(sessionId) },
      { _id: sessionId },
      { id: sessionId },
    ],
  });
  assert.ok(sessionDoc, "JWT session must exist in the Better Auth session collection");
  await db.collection("session").deleteOne({ _id: sessionDoc._id });
  assert.equal((await rawProtected(validToken)).status, 401);
  await db.collection("session").insertOne(sessionDoc);
  assert.equal((await rawProtected(validToken)).status, 200);
  pass("Revoked sessions invalidate otherwise valid JWTs until the session is restored");

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

  const restaurantPayload = (name) => ({
    name,
    description: `A temporary kitchen used for integration tests: ${name}`,
    image: secondImageUrl,
    address: `${100 + name.length} Test Avenue, Pizza City`,
    phone: "+15559876543",
    openingHours: "11:00-23:00",
  });
  const restaurantLimitMessage =
    "You have reached the maximum limit of 3 restaurants. Upgrade to Premium to add more restaurants.";

  // An untrusted vendorId in the body must never be accepted for ownership.
  await api(
    "otherVendor",
    "POST",
    "/api/restaurants/mine",
    { ...restaurantPayload("Untrusted Kitchen"), vendorId: vendor.id },
    400,
  );

  const ownedRestaurants = [];
  for (let index = 1; index <= 3; index += 1) {
    const data = await api(
      "otherVendor",
      "POST",
      "/api/restaurants/mine",
      restaurantPayload(`Limit Kitchen ${index}`),
      201,
    );
    assert.equal(data.restaurant.vendorId, otherVendor.id);
    ownedRestaurants.push(data.restaurant);
  }
  assert.equal(
    await db.collection("restaurants").countDocuments({ vendorId: otherVendor.id }),
    3,
  );
  const blockedRestaurant = await api(
    "otherVendor",
    "POST",
    "/api/restaurants/mine",
    restaurantPayload("Limit Kitchen 4"),
    409,
  );
  assert.equal(blockedRestaurant.message, restaurantLimitMessage);

  const editedAtLimit = await api(
    "otherVendor",
    "PUT",
    `/api/restaurants/mine/${ownedRestaurants[2].id}`,
    restaurantPayload("Limit Kitchen 3 Edited"),
  );
  assert.equal(editedAtLimit.restaurant.name, "Limit Kitchen 3 Edited");
  pass("Free vendors are capped at three restaurants; edits at the cap still work");

  await db.collection("users").updateOne(
    { _id: new ObjectId(otherVendor.id) },
    {
      $set: {
        subscriptionPlan: "premium",
        subscriptionStatus: "active",
        subscriptionExpiresAt: null,
        cancelAtPeriodEnd: false,
      },
    },
  );
  const premiumRestaurant = await api(
    "otherVendor",
    "POST",
    "/api/restaurants/mine",
    restaurantPayload("Premium Kitchen 4"),
    201,
  );
  assert.equal(premiumRestaurant.restaurant.vendorId, otherVendor.id);
  await db.collection("users").updateOne(
    { _id: new ObjectId(otherVendor.id) },
    { $set: { subscriptionPlan: "free", subscriptionStatus: "canceled" } },
  );
  pass("Premium vendors can add restaurants beyond the Free plan cap");

  // Leave this vendor empty for the ownership tests below.
  for (const owned of [...ownedRestaurants, premiumRestaurant.restaurant]) {
    await api("otherVendor", "DELETE", `/api/restaurants/mine/${owned.id}`);
  }

  // Two simultaneous creates from zero restaurants must still yield only one
  // row: the unique free slot is the final authority after the count check.
  const raceResults = await Promise.all(
    ["Race Kitchen A", "Race Kitchen B"].map((name) =>
      fetch(`${API}/api/restaurants/mine`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${tokens.get("otherVendor")}`,
        },
        body: JSON.stringify(restaurantPayload(name)),
      }).then(async (response) => ({
        status: response.status,
        data: await json(response),
      })),
    ),
  );
  assert.deepEqual(
    raceResults.map((result) => result.status).sort((a, b) => a - b),
    [201, 409],
  );
  assert.equal(
    raceResults.find((result) => result.status === 409)?.data.message,
    restaurantLimitMessage,
  );
  assert.equal(
    await db.collection("restaurants").countDocuments({ vendorId: otherVendor.id }),
    1,
  );
  await api(
    "otherVendor",
    "DELETE",
    `/api/restaurants/mine/${raceResults.find((result) => result.status === 201).data.restaurant.id}`,
  );
  pass("Concurrent duplicate creates cannot bypass the Free restaurant cap");

  const menuPayload = (name) => ({
    name,
    description: `A test pizza called ${name} with a full description`,
    category: "Pizza",
    price: 10 + name.length,
    ingredients: ["tomato", "cheese", "basil"],
    location: "Downtown",
    image: imageUrl,
    images: [imageUrl, secondImageUrl],
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
    assert.equal(data.item.approvalStatus, "pending");
    assert.equal(data.item.isActive, false);
    assert.equal(data.item.location, "Downtown");
    assert.deepEqual(data.item.images, [imageUrl, secondImageUrl]);
    assert.equal(data.item.restaurantId, restaurant.restaurant.id);
    assert.equal(data.item.restaurant?.id, restaurant.restaurant.id);
    assert.equal(data.item.restaurant?.name, restaurant.restaurant.name);
    itemIds.push(data.item.id);
  }
  const pendingBrowse = await api(null, "GET", "/api/menu?limit=100");
  for (const id of itemIds) {
    assert.ok(!pendingBrowse.items.some((item) => item.id === id));
  }
  pass("New vendor items are saved pending, hidden, and tied to the sole restaurant");

  for (const id of itemIds) {
    const approved = await api(
      "admin",
      "PATCH",
      `/api/menu/admin/${id}/approval`,
      { approvalStatus: "approved" },
    );
    assert.equal(approved.item.approvalStatus, "approved");
    assert.equal(approved.item.isActive, true);
    assert.equal(approved.message, "Pizza approved and published");
  }
  pass("Admin approval publishes pending items for the public menu");

  for (let index = 0; index < 3; index += 1) {
    await api("vendor", "PATCH", `/api/menu/vendor/${itemIds[index]}`, {
      price: 20 + index,
    });
  }
  pass("Vendor price updates are accepted on approved items");

  const downtownMenu = await api(null, "GET", "/api/menu?location=Downtown&limit=100");
  assert.ok(downtownMenu.items.length >= 3);
  assert.ok(downtownMenu.items.every((item) => item.location === "Downtown"));
  assert.ok(downtownMenu.items.every((item) => item.vendorName === `${vendor.name}`));
  const locations = await api(null, "GET", "/api/menu/locations");
  assert.ok(locations.locations.includes("Downtown"));
  pass("Public menu filters by location and exposes the location list");

  const categoryMenu = await api(
    null,
    "GET",
    `/api/menu?category=${encodeURIComponent("  pizza  ")}&limit=100`,
  );
  assert.ok(categoryMenu.items.length >= 3);
  assert.ok(categoryMenu.items.every((item) => item.category === "Pizza"));
  const categoryOptions = await api(null, "GET", "/api/menu/categories");
  assert.ok(categoryOptions.categories.includes("Pizza"));
  pass("Public menu category filtering is case/spacing tolerant and exposes categories");

  const fourth = await api(
    "vendor",
    "POST",
    "/api/menu/vendor",
    menuPayload("Integration Pizza 4"),
    201,
  );
  assert.equal(fourth.item.approvalStatus, "pending");
  assert.equal(fourth.item.isActive, false);
  assert.equal(fourth.item.restaurantId, restaurant.restaurant.id);
  itemIds.push(fourth.item.id);
  const blockedApproval = await api(
    "admin",
    "PATCH",
    `/api/menu/admin/${fourth.item.id}/approval`,
    { approvalStatus: "approved" },
    409,
  );
  assert.match(blockedApproval.message, /maximum of 3 active menu items/i);
  pass("Free plan blocks admin approval of a fourth active item; pending items are allowed");

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
      ...menuPayload("Integration Pizza Second Location"),
      restaurantId: secondRestaurant.restaurant.id,
    },
    201,
  );
  assert.equal(assignedItem.item.restaurantId, secondRestaurant.restaurant.id);
  assert.equal(assignedItem.item.restaurant?.id, secondRestaurant.restaurant.id);
  assert.equal(assignedItem.item.approvalStatus, "pending");
  await api(
    "vendor",
    "POST",
    "/api/menu/vendor",
    menuPayload("Integration Pizza No Selection"),
    400,
  );
  await api(
    "vendor",
    "POST",
    "/api/menu/vendor",
    {
      ...menuPayload("Integration Pizza Bad Restaurant"),
      restaurantId: new ObjectId().toHexString(),
    },
    400,
  );
  await api(
    "vendor",
    "POST",
    "/api/menu/vendor",
    {
      ...menuPayload("Integration Pizza Foreign Restaurant"),
      restaurantId: foreignRestaurant.restaurant.id,
    },
    400,
  );
  pass("With multiple restaurants an owned ID is required; missing, invalid, and foreign IDs are rejected");

  // --- Admin visibility, unpublish/republish, and takedown ------------------
  const adminAll = await api("admin", "GET", "/api/menu/admin/all?limit=100");
  for (const id of itemIds.slice(0, 3)) {
    const row = adminAll.items.find((item) => item.id === id);
    assert.ok(row, `admin all item ${id}`);
    assert.equal(row.approvalStatus, "approved");
  }
  assert.equal(
    adminAll.items.find((item) => item.id === itemIds[3])?.approvalStatus,
    "pending",
  );
  const adminPending = await api("admin", "GET", "/api/menu/admin/all?status=pending");
  assert.ok(adminPending.items.some((item) => item.id === itemIds[3]));
  const adminSearch = await api("admin", "GET", "/api/menu/admin/all?search=Downtown");
  assert.ok(adminSearch.items.some((item) => item.id === itemIds[0]));
  await api("vendor", "GET", "/api/menu/admin/all", undefined, 403);
  await api("customer", "GET", "/api/menu/admin/all", undefined, 403);
  pass("Admin can filter/search every menu item; non-admins cannot use admin menu routes");

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

  const searchedMenu = await api(
    null,
    "GET",
    `/api/menu?search=${encodeURIComponent("Integration Pizza 1")}&limit=50`,
  );
  assert.deepEqual(searchedMenu.items.map((item) => item.id), [itemIds[0]]);
  const ascMenu = await api(
    null,
    "GET",
    `/api/menu?restaurantId=${restaurant.restaurant.id}&sort=price_asc&limit=50`,
  );
  const descMenu = await api(
    null,
    "GET",
    `/api/menu?restaurantId=${restaurant.restaurant.id}&sort=price_desc&limit=50`,
  );
  assert.deepEqual(ascMenu.items.map((item) => item.id), itemIds.slice(0, 3));
  assert.deepEqual(descMenu.items.map((item) => item.id), [...itemIds.slice(0, 3)].reverse());
  const middlePrice = firstPublic.price + 1;
  const rangedMenu = await api(
    null,
    "GET",
    `/api/menu?restaurantId=${restaurant.restaurant.id}&minPrice=${middlePrice}&maxPrice=${middlePrice}`,
  );
  assert.deepEqual(rangedMenu.items.map((item) => item.id), [itemIds[1]]);
  const pageOne = await api(
    null,
    "GET",
    `/api/menu?restaurantId=${restaurant.restaurant.id}&sort=price_asc&page=1&limit=2`,
  );
  const pageTwo = await api(
    null,
    "GET",
    `/api/menu?restaurantId=${restaurant.restaurant.id}&sort=price_asc&page=2&limit=2`,
  );
  assert.equal(pageOne.pagination.total, 3);
  assert.equal(pageOne.pagination.pages, 2);
  assert.equal(pageOne.items.length, 2);
  assert.equal(pageTwo.items.length, 1);
  assert.equal(pageTwo.items[0].id, itemIds[2]);
  pass("Public menu search, price sorting, bounds, and pagination work together");

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
  assert.match(blockedUpdate.message, /awaiting admin approval/i);
  const blockedToggle = await api(
    "vendor",
    "PATCH",
    `/api/menu/vendor/${itemIds[3]}/active`,
    { isActive: true },
    409,
  );
  assert.match(blockedToggle.message, /awaiting admin approval/i);
  pass("Vendor cannot publish a pending item through edit or availability endpoints");

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
  pass("Admin can hide and restore reviewed items; rejected items stay hidden from customers");

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

  const billingNowSeconds = Math.floor(Date.now() / 1000);
  const futurePeriod = billingNowSeconds + 30 * 24 * 60 * 60;
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
        customer: stripeCustomerId,
        client_reference_id: vendor.id,
        metadata: { vendorId: vendor.id, plan: "monthly" },
        subscription: null,
        amount_total: 1500,
        currency: "usd",
      },
    },
  });
  assert.equal(checkoutCompleted.response.status, 200, JSON.stringify(checkoutCompleted.data));
  pass("Verified checkout.session.completed events are accepted");

  const transactionList = await api("admin", "GET", "/api/admin/transactions");
  const checkoutTransaction = transactionList.transactions.find(
    (entry) => entry.stripeEventId === checkoutEventId,
  );
  assert.ok(checkoutTransaction, "verified checkout must create a transaction record");
  assert.equal(checkoutTransaction.vendorId, vendor.id);
  assert.equal(checkoutTransaction.vendorName, vendor.name);
  assert.equal(checkoutTransaction.vendorEmail, vendor.email);
  assert.equal(checkoutTransaction.plan, "premium");
  assert.equal(checkoutTransaction.amount, 15);
  assert.equal(checkoutTransaction.currency, "USD");
  assert.equal(checkoutTransaction.status, "incomplete");
  await api("vendor", "GET", "/api/admin/transactions", undefined, 403);
  await api("admin", "PATCH", "/api/admin/transactions", { status: "active" }, 404);
  pass("Transactions are read-only, webhook-derived, and admin-only");

  const activationEventId = `evt_it_activate_${suffix}`;
  webhookEventIds.push(activationEventId);
  const activationEvent = subscriptionEvent(activationEventId, {
    customer: stripeCustomerId,
    status: "active",
    cancelAtPeriodEnd: false,
    periodEnd: futurePeriod,
    vendorId: vendor.id,
    created: billingNowSeconds,
    type: "customer.subscription.created",
  });
  const activation = await sendWebhook(activationEvent);
  assert.equal(activation.response.status, 200, JSON.stringify(activation.data));
  const premiumStatus = await api("vendor", "GET", "/api/subscriptions/status");
  assert.equal(premiumStatus.subscription.plan, "premium");
  assert.equal(premiumStatus.subscription.isPremium, true);
  assert.equal(premiumStatus.subscription.stripeSubscriptionId, activationEvent.data.object.id);
  assert.equal(premiumStatus.subscription.stripeCheckoutSessionId, checkout.sessionId);
  assert.equal(premiumStatus.subscription.billingPlanId, "monthly");
  assert.equal(premiumStatus.subscription.stripePriceId, monthlyPriceId);
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

  const wrongOwnerEventId = `evt_it_wrong_owner_${suffix}`;
  webhookEventIds.push(wrongOwnerEventId);
  const wrongOwner = await sendWebhook(
    subscriptionEvent(wrongOwnerEventId, {
      customer: stripeCustomerId,
      status: "active",
      cancelAtPeriodEnd: false,
      periodEnd: futurePeriod + 60 * 60,
      vendorId: otherVendor.id,
      created: billingNowSeconds + 1,
    }),
  );
  assert.equal(wrongOwner.response.status, 200, JSON.stringify(wrongOwner.data));
  const afterWrongOwner = await api("vendor", "GET", "/api/subscriptions/status");
  assert.equal(afterWrongOwner.subscription.stripeCustomerId, stripeCustomerId);
  assert.equal(afterWrongOwner.subscription.stripeSubscriptionId, activationEvent.data.object.id);
  assert.equal(
    new Date(afterWrongOwner.subscription.subscriptionExpiresAt).getTime(),
    futurePeriod * 1000,
  );
  pass("Webhook rejects Stripe metadata that conflicts with the stored vendor owner");

  const paidInvoiceEventId = `evt_it_invoice_paid_${suffix}`;
  webhookEventIds.push(paidInvoiceEventId);
  const paidInvoice = await sendWebhook(
    invoiceEvent(paidInvoiceEventId, {
      customer: stripeCustomerId,
      subscription: activationEvent.data.object,
      paid: true,
      amount: 2000,
      created: billingNowSeconds + 2,
    }),
  );
  assert.equal(paidInvoice.response.status, 200, JSON.stringify(paidInvoice.data));
  const afterPaidInvoice = await api("vendor", "GET", "/api/subscriptions/status");
  assert.equal(afterPaidInvoice.subscription.isPremium, true);
  assert.equal(
    new Date(afterPaidInvoice.subscription.subscriptionExpiresAt).getTime(),
    futurePeriod * 1000,
  );
  const invoiceTransactions = await api("admin", "GET", "/api/admin/transactions");
  const paidTransaction = invoiceTransactions.transactions.find(
    (entry) => entry.stripeEventId === paidInvoiceEventId,
  );
  assert.ok(paidTransaction, "invoice.paid must create a read-only transaction record");
  assert.equal(paidTransaction.amount, 20);
  assert.equal(paidTransaction.status, "active");
  assert.equal(paidTransaction.stripeSubscriptionId, activationEvent.data.object.id);
  pass("Verified invoice.paid renews Premium and records the payment");

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
  assert.equal(billingRow.stripeCheckoutSessionId, checkout.sessionId);
  assert.equal(billingRow.billingPlanId, "monthly");
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
    "admin",
    "PATCH",
    `/api/menu/admin/${itemIds[3]}/approval`,
    { approvalStatus: "approved" },
  );
  assert.equal(fourthActive.item.approvalStatus, "approved");
  assert.equal(fourthActive.item.isActive, true);
  pass("Premium accounts may approve more than three active menu items");

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
      location: "Riverside",
      image: imageUrl,
    },
    201,
  );
  assert.equal(extraItem.item.approvalStatus, "pending");
  assert.equal(extraItem.item.isActive, false);
  const approvedExtra = await api(
    "admin",
    "PATCH",
    `/api/menu/admin/${extraItem.item.id}/approval`,
    { approvalStatus: "approved" },
  );
  assert.equal(approvedExtra.item.approvalStatus, "approved");
  assert.equal(approvedExtra.item.isActive, true);
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
      created: billingNowSeconds + 3,
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
      created: billingNowSeconds + 4,
    }),
  );
  const pastDue = await api("vendor", "GET", "/api/subscriptions/status");
  assert.equal(pastDue.subscription.status, "past_due");
  assert.equal(pastDue.subscription.plan, "free");
  pass("Failed renewal (past_due) removes Premium until Stripe restores it");

  const failedInvoiceEventId = `evt_it_invoice_failed_${suffix}`;
  webhookEventIds.push(failedInvoiceEventId);
  const failedSubscription = subscriptionEvent(`evt_unused_${suffix}`, {
    customer: stripeCustomerId,
    status: "past_due",
    cancelAtPeriodEnd: false,
    periodEnd: futurePeriod,
    vendorId: vendor.id,
    created: billingNowSeconds + 5,
  }).data.object;
  const failedInvoice = await sendWebhook(
    invoiceEvent(failedInvoiceEventId, {
      customer: stripeCustomerId,
      subscription: failedSubscription,
      paid: false,
      amount: 2500,
      created: billingNowSeconds + 5,
    }),
  );
  assert.equal(failedInvoice.response.status, 200, JSON.stringify(failedInvoice.data));
  const failedInvoiceStatus = await api("vendor", "GET", "/api/subscriptions/status");
  assert.equal(failedInvoiceStatus.subscription.status, "past_due");
  const failedTransactions = await api("admin", "GET", "/api/admin/transactions");
  const failedTransaction = failedTransactions.transactions.find(
    (entry) => entry.stripeEventId === failedInvoiceEventId,
  );
  assert.ok(failedTransaction, "invoice.payment_failed must record a failed renewal");
  assert.equal(failedTransaction.amount, 25);
  assert.equal(failedTransaction.status, "past_due");
  pass("Verified invoice.payment_failed records the failed renewal without restoring Premium");

  const deletedEventId = `evt_it_deleted_${suffix}`;
  webhookEventIds.push(deletedEventId);
  const deleted = await sendWebhook(
    subscriptionEvent(deletedEventId, {
      customer: stripeCustomerId,
      status: "canceled",
      cancelAtPeriodEnd: false,
      periodEnd: futurePeriod,
      vendorId: vendor.id,
      created: billingNowSeconds + 6,
      type: "customer.subscription.deleted",
    }),
  );
  assert.equal(deleted.response.status, 200, JSON.stringify(deleted.data));
  const canceledStatus = await api("vendor", "GET", "/api/subscriptions/status");
  assert.equal(canceledStatus.subscription.status, "canceled");
  assert.equal(canceledStatus.subscription.plan, "free");
  pass("Verified subscription.deleted webhook deactivates Premium");

  const staleEventId = `evt_it_stale_${suffix}`;
  webhookEventIds.push(staleEventId);
  const stale = await sendWebhook(
    subscriptionEvent(staleEventId, {
      customer: stripeCustomerId,
      status: "active",
      cancelAtPeriodEnd: false,
      periodEnd: futurePeriod + 24 * 60 * 60,
      vendorId: vendor.id,
      created: billingNowSeconds - 120,
    }),
  );
  assert.equal(stale.response.status, 200, JSON.stringify(stale.data));
  const afterStale = await api("vendor", "GET", "/api/subscriptions/status");
  assert.equal(afterStale.subscription.status, "canceled");
  assert.equal(afterStale.subscription.isPremium, false);
  assert.equal(
    new Date(afterStale.subscription.subscriptionExpiresAt).getTime(),
    futurePeriod * 1000,
  );
  pass("Delayed older Stripe events cannot overwrite newer subscription state");

  const resubscriptionEventId = `evt_it_resubscribe_${suffix}`;
  webhookEventIds.push(resubscriptionEventId);
  const resubscription = await sendWebhook(
    subscriptionEvent(resubscriptionEventId, {
      customer: stripeCustomerId,
      status: "active",
      cancelAtPeriodEnd: false,
      periodEnd: futurePeriod + 30 * 24 * 60 * 60,
      vendorId: vendor.id,
      plan: "yearly",
      priceId: yearlyPriceId,
      subscriptionId: `sub_it_renew_${suffix}`,
      created: billingNowSeconds + 7,
      type: "customer.subscription.created",
    }),
  );
  assert.equal(resubscription.response.status, 200, JSON.stringify(resubscription.data));
  const resubscribed = await api("vendor", "GET", "/api/subscriptions/status");
  assert.equal(resubscribed.subscription.isPremium, true);
  assert.equal(resubscribed.subscription.stripeSubscriptionId, `sub_it_renew_${suffix}`);
  assert.equal(resubscribed.subscription.billingPlanId, "yearly");
  assert.equal(resubscribed.subscription.stripePriceId, yearlyPriceId);
  pass("A new active subscription can replace a terminal canceled subscription");

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
  const transactionsBeforeOrder = await api("admin", "GET", "/api/admin/transactions");
  const created = await api("customer", "POST", "/api/orders", orderPayload, 201);
  const order = created.order;
  assert.equal(order.status, "pending");
  assert.ok(created.email, "new order response must include email results");
  assert.equal(typeof created.email.vendor.sent, "boolean");
  assert.equal(typeof created.email.customer.sent, "boolean");
  const paymentLikeKeys = Object.keys(order).filter((key) =>
    /stripe|payment|checkout/i.test(key),
  );
  assert.deepEqual(paymentLikeKeys, [], "order DTO must not contain payment fields");
  const transactionsAfterOrder = await api("admin", "GET", "/api/admin/transactions");
  assert.equal(
    transactionsAfterOrder.transactions.length,
    transactionsBeforeOrder.transactions.length,
    "placing a customer order must not create Stripe billing records",
  );
  await api("customer", "POST", "/api/orders", orderPayload, 409);
  pass("Order creation stores the order, returns email status, and blocks duplicates");
  pass("Customer pizza orders are Stripe-free and create no payment records");

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
    if (expectedStatus === "accepted") {
      assert.ok(result.email && typeof result.email.sent === "boolean");
    }
    previousLength = result.order.timeline.length;
  }
  pass("Order accept/status transitions append timeline entries");

  const repeat = await api("customer", "POST", "/api/orders", orderPayload, 201);
  await api("customer", "PATCH", `/api/orders/${repeat.order.id}/cancel`);
  pass("Delivered orders release the active-order slot");

  const rejectable = await api(
    "customer",
    "POST",
    "/api/orders",
    { ...orderPayload, menuItemId: itemIds[1], quantity: 1 },
    201,
  );
  const orderDetails = await api("customer", "GET", `/api/orders/${rejectable.order.id}`);
  assert.equal(orderDetails.order.id, rejectable.order.id);
  assert.ok(Array.isArray(orderDetails.order.timeline));
  await api("otherVendor", "GET", `/api/orders/${rejectable.order.id}`, undefined, 403);
  const rejectedOrder = await api(
    "vendor",
    "PATCH",
    `/api/orders/${rejectable.order.id}/reject`,
  );
  assert.equal(rejectedOrder.order.status, "rejected");
  assert.ok(rejectedOrder.email && typeof rejectedOrder.email.sent === "boolean");
  const adminOrderDetails = await api("admin", "GET", `/api/orders/${rejectable.order.id}`);
  assert.equal(adminOrderDetails.order.status, "rejected");
  await api("vendor", "PATCH", `/api/orders/${rejectable.order.id}/accept`, undefined, 409);
  pass("Order details enforce ownership and reject transitions return email status");

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

  const restaurantReview = await api(
    "customer",
    "POST",
    `/api/reviews/restaurant/${restaurant.restaurant.id}`,
    {
      orderId: order.id,
      rating: 4,
      comment: "A warm and welcoming integration kitchen",
    },
    201,
  );
  assert.equal(restaurantReview.review.restaurantId, restaurant.restaurant.id);
  assert.equal(restaurantReview.review.menuItemId, null);
  await api(
    "customer",
    "POST",
    `/api/reviews/restaurant/${restaurant.restaurant.id}`,
    {
      orderId: order.id,
      rating: 5,
      comment: "Duplicate restaurant review attempt",
    },
    409,
  );
  await api(
    "customer",
    "POST",
    `/api/reviews/restaurant/${foreignRestaurant.restaurant.id}`,
    {
      orderId: order.id,
      rating: 5,
      comment: "This order came from another kitchen",
    },
    400,
  );
  await api(
    "vendor",
    "POST",
    `/api/reviews/restaurant/${restaurant.restaurant.id}`,
    {
      orderId: order.id,
      rating: 5,
      comment: "Vendors cannot review restaurants",
    },
    403,
  );
  await api(
    null,
    "POST",
    `/api/reviews/restaurant/${restaurant.restaurant.id}`,
    {
      orderId: order.id,
      rating: 5,
      comment: "Guests cannot review restaurants",
    },
    401,
  );
  const restaurantReviews = await api(
    null,
    "GET",
    `/api/reviews/restaurant/${restaurant.restaurant.id}?limit=20`,
  );
  assert.ok(
    restaurantReviews.reviews.some(
      (review) => review.comment === "A warm and welcoming integration kitchen",
    ),
  );
  const ratedRestaurant = await api(
    null,
    "GET",
    `/api/restaurants/${restaurant.restaurant.id}`,
  );
  assert.equal(ratedRestaurant.restaurant.reviewCount, 1);
  assert.equal(ratedRestaurant.restaurant.ratingAvg, 4);
  pass("Restaurant reviews validate delivery, dedupe, roles, and update restaurant ratings");

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
  assert.equal(typeof stats.stats.pendingMenuItems, "number");
  assert.ok(stats.stats.totalMenuItems >= 4);
  assert.ok(stats.stats.totalTransactions >= 1);
  pass("Admin stats returns users, menu, pending items, and transaction totals");

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
      db.collection("transactions").deleteMany({
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
