import { Router } from "express";

import {
  checkoutSchema,
  createOrderCheckout,
  getPayment,
  getSession,
  listMyPayments,
  listVendorPayments,
} from "../controllers/payments.controller.js";
import { requireRole, verifyToken } from "../middleware/auth.middleware.js";
import { validateBody } from "../middleware/validate.js";

const router = Router();

router.use(verifyToken);

router.post(
  "/checkout",
  requireRole("customer"),
  validateBody(checkoutSchema),
  createOrderCheckout,
);
router.get("/session/:sessionId", requireRole("customer", "admin"), getSession);
router.get("/my", requireRole("customer"), listMyPayments);
router.get("/vendor", requireRole("vendor"), listVendorPayments);
router.get("/:id", requireRole("customer", "vendor", "admin"), getPayment);

export default router;
