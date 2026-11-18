import express, { Router } from "express";

import { stripeWebhook } from "../controllers/webhooks.controller.js";

const router = Router();

// Mounted at /api/stripe, so this is POST /api/stripe/webhook.
// Must be registered before express.json(): Stripe verifies the raw body bytes.
router.post("/webhook", express.raw({ type: "*/*" }), stripeWebhook);

export default router;
