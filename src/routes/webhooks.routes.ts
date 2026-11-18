import express, { Router } from "express";

import { stripeWebhook } from "../controllers/webhooks.controller.js";

const router = Router();

// Must be mounted before express.json(): Stripe verifies the raw body bytes.
router.post("/stripe", express.raw({ type: "*/*" }), stripeWebhook);

export default router;
