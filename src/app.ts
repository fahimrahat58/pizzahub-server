import cors from "cors";
import express from "express";

import { initializeRuntime } from "./config/bootstrap.js";
import { env } from "./config/env.js";
import { errorHandler } from "./utils/errors.js";

import testRoutes from "./routes/test.routes.js";
import authRoutes from "./routes/auth.routes.js";
import userRoutes from "./routes/users.routes.js";
import restaurantRoutes from "./routes/restaurants.routes.js";
import menuRoutes from "./routes/menu.routes.js";
import orderRoutes from "./routes/orders.routes.js";
import favoriteRoutes from "./routes/favorites.routes.js";
import reviewRoutes from "./routes/reviews.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import uploadRoutes from "./routes/uploads.routes.js";
import subscriptionRoutes from "./routes/subscriptions.routes.js";
import webhookRoutes from "./routes/webhooks.routes.js";

const app = express();

// Every request waits for the shared MongoDB/index/migration initialization.
// This is a no-op after the first successful invocation.
app.use(async (_req, _res, next) => {
  try {
    await initializeRuntime();
    next();
  } catch (error) {
    next(error);
  }
});

app.use(
  cors({
    origin: env.frontendUrl.split(",").map((origin) => origin.trim()),
    credentials: true,
  }),
);
// Stripe calls POST /api/stripe/webhook. The router is mounted BEFORE
// express.json() so signature verification receives the untouched raw bytes.
app.use("/api/stripe", webhookRoutes);

app.use(express.json({ limit: "8mb" }));

app.get("/", (_req, res) => {
  res.json({ success: true, message: "PizzaHub API is running!" });
});

app.get("/api/health", (_req, res) => {
  res.json({ success: true, message: "Server is healthy" });
});

app.use("/api/test", testRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/restaurants", restaurantRoutes);
app.use("/api/menu", menuRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/favorites", favoriteRoutes);
app.use("/api/reviews", reviewRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/uploads", uploadRoutes);
app.use("/api/subscriptions", subscriptionRoutes);

app.use((_req, res) => {
  res.status(404).json({ success: false, message: "Endpoint not found" });
});

app.use(errorHandler);

export default app;
