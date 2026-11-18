import { MongoClient, type Collection, type Db, type ObjectId } from "mongodb";

import { env } from "./env.js";
import type {
  FavoriteDoc,
  MenuItemDoc,
  OrderDoc,
  RestaurantDoc,
  ReviewDoc,
  StripeEventDoc,
  TransactionDoc,
  SubscriptionEventDoc,
  UserDoc,
} from "../types/models.js";

export const mongoClient = new MongoClient(env.mongoUri, {
  serverSelectionTimeoutMS: 10_000,
});

export const db: Db = mongoClient.db(env.dbName);

let isConnected = false;

export const connectDB = async (): Promise<void> => {
  if (isConnected) return;

  try {
    await mongoClient.connect();
    await db.command({ ping: 1 });
    isConnected = true;
    console.log(`MongoDB connected (${env.dbName})`);
  } catch (error) {
    isConnected = false;
    console.error("MongoDB connection failed:", error);
    throw error;
  }
};

export const collections = {
  users: (): Collection<UserDoc> => db.collection<UserDoc>("users"),
  // Better Auth uses the singular `session` collection by default, and its
  // Mongo adapter stores ObjectId values for both `_id` and `userId`.
  sessions: (): Collection<{
    _id: ObjectId;
    id: string;
    userId: ObjectId;
    token: string;
    expiresAt: Date;
  }> => db.collection("session"),
  menuItems: (): Collection<MenuItemDoc> =>
    db.collection<MenuItemDoc>("menuItems"),
  restaurants: (): Collection<RestaurantDoc> =>
    db.collection<RestaurantDoc>("restaurants"),
  orders: (): Collection<OrderDoc> => db.collection<OrderDoc>("orders"),
  favorites: (): Collection<FavoriteDoc> =>
    db.collection<FavoriteDoc>("favorites"),
  reviews: (): Collection<ReviewDoc> => db.collection<ReviewDoc>("reviews"),
  // Webhook idempotency ledger. `_id` is the Stripe event id.
  stripeEvents: (): Collection<StripeEventDoc> =>
    db.collection<StripeEventDoc>("stripeEvents"),
  // Read-only billing history derived exclusively from verified webhooks.
  subscriptionEvents: (): Collection<SubscriptionEventDoc> =>
    db.collection<SubscriptionEventDoc>("subscriptionEvents"),
  // Read-only payment transactions created from verified Stripe webhooks.
  transactions: (): Collection<TransactionDoc> =>
    db.collection<TransactionDoc>("transactions"),
};
