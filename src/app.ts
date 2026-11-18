import cors from "cors";
import express from "express";

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

app.use(
  cors({
    origin: env.frontendUrl.split(",").map((origin) => origin.trim()),
    credentials: true,
  }),
);
// Stripe needs the untouched request body for signature verification, so this
// route is registered BEFORE express.json().
app.use("/api/webhooks", webhookRoutes);

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
