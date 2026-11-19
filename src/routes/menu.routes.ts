import { Router } from "express";
import { z } from "zod";

import {
  adminDeleteMenuItem,
  approvalSchema,
  createMenuItem,
  createMenuItemSchema,
  deleteMenuItem,
  getFeaturedMenu,
  getPublicMenuItem,
  listAdminMenu,
  listCategories,
  listLocations,
  listPendingMenu,
  listPublicMenu,
  listVendorMenu,
  reviewMenuItem,
  toggleMenuItemActive,
  updateMenuItem,
  updateMenuItemSchema,
} from "../controllers/menu.controller.js";
import { requireRole, verifyToken } from "../middleware/auth.middleware.js";
import {
  validateBody,
  validateParams,
  objectIdParamSchema,
} from "../middleware/validate.js";

const router = Router();

// Static/public discovery routes must be registered before /:id.
router.get("/featured", getFeaturedMenu);
router.get("/categories", listCategories);
router.get("/locations", listLocations);
router.get("/", listPublicMenu);

// Vendor menu management
router.get("/vendor/mine", verifyToken, requireRole("vendor"), listVendorMenu);
router.post(
  "/vendor",
  verifyToken,
  requireRole("vendor"),
  validateBody(createMenuItemSchema),
  createMenuItem,
);
router.patch(
  "/vendor/:id",
  verifyToken,
  requireRole("vendor"),
  validateParams(objectIdParamSchema),
  validateBody(updateMenuItemSchema),
  updateMenuItem,
);
router.delete(
  "/vendor/:id",
  verifyToken,
  requireRole("vendor"),
  validateParams(objectIdParamSchema),
  deleteMenuItem,
);
router.patch(
  "/vendor/:id/active",
  verifyToken,
  requireRole("vendor"),
  validateParams(objectIdParamSchema),
  validateBody(z.object({ isActive: z.boolean() }).strict()),
  toggleMenuItemActive,
);

// Admin menu management. Approval is never required to publish; these routes
// only support takedown/restoration and removal when necessary.
router.get("/admin/all", verifyToken, requireRole("admin"), listAdminMenu);
router.get("/admin/pending", verifyToken, requireRole("admin"), listPendingMenu);
router.patch(
  "/admin/:id/approval",
  verifyToken,
  requireRole("admin"),
  validateParams(objectIdParamSchema),
  validateBody(approvalSchema),
  reviewMenuItem,
);
router.delete(
  "/admin/:id",
  verifyToken,
  requireRole("admin"),
  validateParams(objectIdParamSchema),
  adminDeleteMenuItem,
);

// Dynamic public detail route last
router.get("/:id", validateParams(objectIdParamSchema), getPublicMenuItem);

export default router;
