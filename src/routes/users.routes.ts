import { Router } from "express";

import {
  adminChangeRole,
  adminDeleteUser,
  adminGetSubscriptionHistory,
  adminGetUser,
  adminListSubscriptions,
  adminListUsers,
  adminSetBlocked,
  getProfile,
  updateImageSchema,
  updateMeSchema,
  updateProfile,
  updateProfileImage,
} from "../controllers/users.controller.js";
import { requireRole, verifyToken } from "../middleware/auth.middleware.js";
import {
  validateBody,
  validateParams,
  objectIdParamSchema,
} from "../middleware/validate.js";

const router = Router();

router.use(verifyToken);

router.get("/me", getProfile);
router.patch("/me", validateBody(updateMeSchema), updateProfile);
router.patch(
  "/me/image",
  validateBody(updateImageSchema),
  updateProfileImage,
);

router.get("/admin", requireRole("admin"), adminListUsers);
// Static billing paths must precede /admin/:id.
router.get(
  "/admin/subscriptions",
  requireRole("admin"),
  adminListSubscriptions,
);
router.get(
  "/admin/subscriptions/:id/history",
  requireRole("admin"),
  validateParams(objectIdParamSchema),
  adminGetSubscriptionHistory,
);
router.get(
  "/admin/:id",
  requireRole("admin"),
  validateParams(objectIdParamSchema),
  adminGetUser,
);
router.patch(
  "/admin/:id/block",
  requireRole("admin"),
  validateParams(objectIdParamSchema),
  adminSetBlocked,
);
router.patch(
  "/admin/:id/role",
  requireRole("admin"),
  validateParams(objectIdParamSchema),
  adminChangeRole,
);
router.delete(
  "/admin/:id",
  requireRole("admin"),
  validateParams(objectIdParamSchema),
  adminDeleteUser,
);

export default router;
