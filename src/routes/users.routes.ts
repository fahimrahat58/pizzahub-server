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
import { validateBody } from "../middleware/validate.js";

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
  adminGetSubscriptionHistory,
);
router.get("/admin/:id", requireRole("admin"), adminGetUser);
router.patch("/admin/:id/block", requireRole("admin"), adminSetBlocked);
router.patch("/admin/:id/role", requireRole("admin"), adminChangeRole);
router.delete("/admin/:id", requireRole("admin"), adminDeleteUser);

export default router;
