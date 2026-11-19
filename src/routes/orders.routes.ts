import { Router } from "express";

import {
  acceptOrder,
  cancelOrder,
  createOrder,
  getOrder,
  listAllOrders,
  listMyOrders,
  listVendorOrders,
  markVendorOrdersSeen,
  rejectOrder,
  statusSchema,
  updateOrderStatus,
  getVendorUnseenOrderCount,
} from "../controllers/orders.controller.js";
import { requireRole, verifyToken } from "../middleware/auth.middleware.js";
import {
  validateBody,
  validateParams,
  objectIdParamSchema,
} from "../middleware/validate.js";

const router = Router();

router.use(verifyToken);

router.post("/", requireRole("customer"), createOrder);

router.get("/my", requireRole("customer"), listMyOrders);
router.get("/vendor", requireRole("vendor"), listVendorOrders);
router.get("/admin", requireRole("admin"), listAllOrders);
router.get("/vendor/unseen", requireRole("vendor"), getVendorUnseenOrderCount);
router.post("/vendor/seen", requireRole("vendor"), markVendorOrdersSeen);

router.get("/:id", validateParams(objectIdParamSchema), getOrder);
router.patch(
  "/:id/cancel",
  requireRole("customer"),
  validateParams(objectIdParamSchema),
  cancelOrder,
);
router.patch(
  "/:id/accept",
  requireRole("vendor"),
  validateParams(objectIdParamSchema),
  acceptOrder,
);
router.patch(
  "/:id/reject",
  requireRole("vendor"),
  validateParams(objectIdParamSchema),
  rejectOrder,
);
router.patch(
  "/:id/status",
  requireRole("vendor"),
  validateParams(objectIdParamSchema),
  validateBody(statusSchema),
  updateOrderStatus,
);

export default router;
