import { Router } from "express";

import {
  acceptOrder,
  cancelOrder,
  createOrder,
  getOrder,
  listAllOrders,
  listMyOrders,
  listVendorOrders,
  rejectOrder,
  updateOrderStatus,
} from "../controllers/orders.controller.js";
import { requireRole, verifyToken } from "../middleware/auth.middleware.js";

const router = Router();

router.use(verifyToken);

router.post("/", requireRole("customer"), createOrder);

router.get("/my", requireRole("customer"), listMyOrders);
router.get("/vendor", requireRole("vendor"), listVendorOrders);
router.get("/admin", requireRole("admin"), listAllOrders);

router.get("/:id", getOrder);
router.patch("/:id/cancel", requireRole("customer"), cancelOrder);
router.patch("/:id/accept", requireRole("vendor"), acceptOrder);
router.patch("/:id/reject", requireRole("vendor"), rejectOrder);
router.patch("/:id/status", requireRole("vendor"), updateOrderStatus);

export default router;
