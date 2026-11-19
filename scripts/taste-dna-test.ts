/**
 * Focused regression checks for PizzaHub Taste DNA. These use in-memory fake
 * collections so no MongoDB documents are created, changed, or deleted.
 * Run with: npx --no-install tsx scripts/taste-dna-test.ts
 */
import assert from "node:assert/strict";
import express from "express";
import { ObjectId } from "mongodb";

import { collections } from "../src/config/database.js";
import { requireRole } from "../src/middleware/auth.middleware.js";
import recommendationRoutes from "../src/routes/recommendations.routes.js";
import { buildTasteDna } from "../src/services/recommendation.service.js";
import { errorHandler } from "../src/utils/errors.js";

type Doc = Record<string, any>;

const customerA = "111111111111111111111111";
const customerB = "222222222222222222222222";

let data: { orders: Doc[]; favorites: Doc[]; reviews: Doc[]; menuItems: Doc[] } = {
  orders: [],
  favorites: [],
  reviews: [],
  menuItems: [],
};
const filters: Record<string, Doc[]> = {
  orders: [],
  favorites: [],
  reviews: [],
  menuItems: [],
};

const isPublic = (item: Doc): boolean =>
  item.approvalStatus === "approved" && item.isActive === true;

const fakeCollection = (name: keyof typeof data) => ({
  find(filter: Doc = {}, options: Doc = {}) {
    filters[name].push(filter);
    let rows = [...data[name]];
    if (name === "orders") {
      rows = rows.filter(
        (row) => row.customerId === filter.customerId && (!filter.status || row.status === filter.status),
      );
    }
    if (name === "favorites") {
      rows = rows.filter((row) => row.customerId === filter.customerId);
    }
    if (name === "reviews") {
      rows = rows.filter(
        (row) =>
          row.customerId === filter.customerId &&
          (!filter.menuItemId?.$type || row.menuItemId instanceof ObjectId) &&
          (filter.isHidden?.$ne === undefined || row.isHidden !== filter.isHidden.$ne),
      );
    }
    if (name === "menuItems") {
      const ids = (filter._id?.$in as ObjectId[] | undefined)?.map((id) => id.toHexString());
      rows = rows.filter((row) =>
        ids ? ids.includes((row._id as ObjectId).toHexString()) : isPublic(row),
      );
      if (options.sort?.isFeatured !== undefined) {
        rows.sort((a, b) => Number(b.isFeatured) - Number(a.isFeatured));
      }
      if (typeof options.limit === "number") rows = rows.slice(0, options.limit);
    }
    return { toArray: async () => rows };
  },
  aggregate(pipeline: Doc[]) {
    const match = pipeline[0]?.$match ?? {};
    filters.menuItems.push(match);
    const ids = ((match._id?.$in ?? []) as ObjectId[]).map((id) => id.toHexString());
    const rows = data.menuItems
      .filter((row) => ids.includes((row._id as ObjectId).toHexString()) && isPublic(row))
      .map((row) => ({
        ...row,
        ratingAvg: 4.5,
        reviewCount: 2,
        ratingDistribution: { "1": 0, "2": 0, "3": 0, "4": 1, "5": 1 },
        vendorName: "Test vendor",
        restaurantInfo: [],
      }));
    return { toArray: async () => rows };
  },
});

const patched = collections as unknown as Record<string, unknown>;
for (const name of ["orders", "favorites", "reviews", "menuItems"] as const) {
  patched[name] = () => fakeCollection(name);
}

const item = (
  hex: string,
  name: string,
  category: string,
  ingredients: string[],
  price: number,
  extra: Doc = {},
): Doc => ({
  _id: new ObjectId(hex),
  vendorId: "333333333333333333333333",
  restaurantId: null,
  name,
  description: "A test pizza",
  category,
  price,
  ingredients,
  location: "Test City",
  image: "https://example.com/pizza.png",
  images: [],
  isActive: true,
  approvalStatus: "approved",
  isFeatured: false,
  vendorPremium: false,
  rejectionReason: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...extra,
});

const reset = () => {
  data = { orders: [], favorites: [], reviews: [], menuItems: [] };
  for (const key of Object.keys(filters)) filters[key] = [];
};

const assertScores = (result: Awaited<ReturnType<typeof buildTasteDna>>) => {
  for (const recommendation of result.recommendations) {
    assert.ok(
      Number.isInteger(recommendation.matchScore) &&
        recommendation.matchScore >= 0 &&
        recommendation.matchScore <= 100,
      `match score out of range: ${recommendation.matchScore}`,
    );
    assert.ok(recommendation.reasons.length > 0, "recommendation must include a reason");
  }
};

const publicIds = (result: Awaited<ReturnType<typeof buildTasteDna>>) =>
  result.recommendations.map((entry) => entry.item.id);

const run = async () => {
  // 1. Customer with no activity gets an honest empty profile.
  reset();
  data.menuItems = [
    item("aaaaaaaaaaaaaaaaaaaaaaaa", "Chicken Classic", "Classic", ["Chicken", "Mozzarella"], 14),
    item("bbbbbbbbbbbbbbbbbbbbbbbb", "Hidden Special", "Specialty", ["Truffle"], 22, { isActive: false }),
  ];
  const empty = await buildTasteDna(customerA, 8);
  assert.equal(empty.profile.totalSignals, 0);
  assert.equal(empty.profile.status, "empty");
  assert.deepEqual(empty.recommendations, []);
  assert.equal(empty.profile.budgetRange.min, null);
  assert.match(empty.profile.summary, /enough activity/i);

  // 2. Favorites-only customer gets a developing, data-backed profile.
  reset();
  const chicken = item("cccccccccccccccccccccccc", "Chicken Deluxe", "Classic", ["Chicken", "Mozzarella"], 15);
  const veggie = item("dddddddddddddddddddddddd", "Garden Pizza", "Vegetarian", ["Mushroom", "Olives"], 13);
  data.menuItems = [
    chicken,
    veggie,
    item("eeeeeeeeeeeeeeeeeeeeeeee", "Rejected Pizza", "Classic", ["Chicken"], 12, {
      approvalStatus: "rejected",
    }),
    item("ffffffffffffffffffffffff", "Inactive Pizza", "Classic", ["Chicken"], 12, { isActive: false }),
  ];
  data.favorites = [{ customerId: customerA, menuItemId: chicken._id }];
  const favoritesOnly = await buildTasteDna(customerA, 8);
  assert.equal(favoritesOnly.profile.status, "developing");
  assert.equal(favoritesOnly.profile.totalSignals, 1);
  assert.ok(favoritesOnly.profile.topCategories.some((entry) => entry.name === "Classic"));
  assert.ok(favoritesOnly.profile.favoriteIngredients.some((entry) => entry.name === "Chicken"));
  assert.ok(favoritesOnly.recommendations.length > 0);
  assertScores(favoritesOnly);
  assert.ok(!publicIds(favoritesOnly).includes("eeeeeeeeeeeeeeeeeeeeeeee"));
  assert.ok(!publicIds(favoritesOnly).includes("ffffffffffffffffffffffff"));
  assert.ok(
    favoritesOnly.recommendations.some((entry) =>
      entry.reasons.some((reason) => reason.includes("Chicken") || reason.includes("Classic")),
    ),
    "reasons must come from the customer's real data",
  );

  // 3. A 1-star review excludes that pizza and weakens similar recommendations.
  reset();
  const similar = item("555555555555555555555555", "Chicken Pizza", "Classic", ["Chicken", "Mozzarella"], 16);
  const anotherChicken = item("777777777777777777777777", "Chicken Classic", "Classic", ["Chicken", "Mozzarella"], 16);
  data.menuItems = [chicken, similar, veggie, anotherChicken];
  data.favorites = [
    { customerId: customerA, menuItemId: chicken._id },
    { customerId: customerA, menuItemId: anotherChicken._id },
  ];
  data.orders = [
    {
      customerId: customerA,
      menuItemId: anotherChicken._id,
      unitPrice: 16,
      quantity: 1,
      status: "delivered",
    },
  ];
  data.reviews = [{ customerId: customerA, menuItemId: chicken._id, rating: 5 }];
  const positive = await buildTasteDna(customerA, 8);
  data.reviews = [{ customerId: customerA, menuItemId: chicken._id, rating: 1 }];
  const negative = await buildTasteDna(customerA, 8);
  assert.ok(!publicIds(negative).includes("cccccccccccccccccccccccc"), "1-star pizza must not be recommended");
  const positiveSimilar = positive.recommendations.find((entry) => entry.item.id === "555555555555555555555555");
  const negativeSimilar = negative.recommendations.find((entry) => entry.item.id === "555555555555555555555555");
  assert.ok(positiveSimilar && negativeSimilar, "similar pizza should be available in both scenarios");
  assert.ok(
    negativeSimilar.matchScore < positiveSimilar.matchScore,
    `negative review should reduce affinity (${negativeSimilar.matchScore} vs ${positiveSimilar.matchScore})`,
  );
  assertScores(negative);

  // 4. Deleted menu items referenced by history do not crash the endpoint.
  reset();
  const ghost = new ObjectId();
  data.menuItems = [veggie];
  data.orders = [
    { customerId: customerA, menuItemId: ghost, unitPrice: 12, quantity: 1, status: "delivered" },
  ];
  data.favorites = [{ customerId: customerA, menuItemId: ghost }];
  data.reviews = [{ customerId: customerA, menuItemId: ghost, rating: 2 }];
  const withDeletedItems = await buildTasteDna(customerA, 8);
  assert.equal(withDeletedItems.profile.totalSignals, 0);
  assert.equal(withDeletedItems.profile.budgetRange.sampleSize, 1);
  assert.deepEqual(withDeletedItems.recommendations, []);

  // 5. Each customer is isolated to their own signals and query filters.
  reset();
  data.menuItems = [chicken, veggie];
  data.favorites = [
    { customerId: customerA, menuItemId: chicken._id },
    { customerId: customerB, menuItemId: veggie._id },
  ];
  const profileA = await buildTasteDna(customerA, 8);
  const profileB = await buildTasteDna(customerB, 8);
  assert.ok(profileA.profile.topCategories.some((entry) => entry.name === "Classic"));
  assert.ok(!profileA.profile.topCategories.some((entry) => entry.name === "Vegetarian"));
  assert.ok(profileB.profile.topCategories.some((entry) => entry.name === "Vegetarian"));
  assert.ok(!profileB.profile.topCategories.some((entry) => entry.name === "Classic"));
  for (const key of ["orders", "favorites", "reviews"]) {
    for (const filter of filters[key]) {
      assert.ok(
        filter.customerId === customerA || filter.customerId === customerB,
        `${key} query must be scoped to an authenticated customer id`,
      );
    }
  }

  // 6. Route authorization: anonymous is rejected and non-customers are blocked.
  const app = express();
  app.use(express.json());
  app.use("/api/recommendations", recommendationRoutes);
  app.get(
    "/probe",
    (req, _res, next) => {
      req.user = {
        id: customerA,
        role: "vendor",
        name: "Test",
        email: "test@example.com",
      };
      next();
    },
    requireRole("customer"),
    (_req, res) => res.json({ success: true }),
  );
  app.get(
    "/probe-customer",
    (req, _res, next) => {
      req.user = {
        id: customerA,
        role: "customer",
        name: "Test",
        email: "test@example.com",
      };
      next();
    },
    requireRole("customer"),
    (_req, res) => res.json({ success: true }),
  );
  app.get(
    "/probe-admin",
    (req, _res, next) => {
      req.user = {
        id: customerA,
        role: "admin",
        name: "Test",
        email: "test@example.com",
      };
      next();
    },
    requireRole("customer"),
    (_req, res) => res.json({ success: true }),
  );
  app.use(errorHandler);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;

  const anonymous = await fetch(`${base}/api/recommendations/taste-dna`);
  assert.equal(anonymous.status, 401);
  const anonymousBody = (await anonymous.json()) as Doc;
  assert.equal(anonymousBody.success, false);
  assert.match(anonymousBody.message, /token is required/i);

  const vendorProbe = await fetch(`${base}/probe`);
  assert.equal(vendorProbe.status, 403);
  const adminProbe = await fetch(`${base}/probe-admin`);
  assert.equal(adminProbe.status, 403);
  const customerProbe = await fetch(`${base}/probe-customer`);
  assert.equal(customerProbe.status, 200);
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );

  console.log("Taste DNA checks passed (empty, developing, negative, deleted, isolation, visibility, score bounds, auth).");
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
