import { Router } from "express";

import {
  checkoutSchema,
  createCheckoutSession,
  createPortalSession,
  getPlans,
  getSubscriptionStatus,
} from "../controllers/subscriptions.controller.js";
import { requireRole, verifyToken } from "../middleware/auth.middleware.js";
import { validateBody } from "../middleware/validate.js";

const router = Router();

// Every billing route is scoped to the authenticated vendor. No vendor can
// read or modify another vendor's subscription.
router.use(verifyToken, requireRole("vendor"));

router.get("/plans", getPlans);
router.get("/status", getSubscriptionStatus);
router.post(
  "/create-checkout-session",
  validateBody(checkoutSchema),
  createCheckoutSession,
);
router.post("/create-portal-session", createPortalSession);

export default router;
