import { Router } from "express";

import {
  dashboardStats,
  deleteReview,
  listReviews,
  listTransactions,
  setReviewHidden,
} from "../controllers/admin.controller.js";
import { requireRole, verifyToken } from "../middleware/auth.middleware.js";
import {
  validateParams,
  objectIdParamSchema,
} from "../middleware/validate.js";

const router = Router();

router.use(verifyToken, requireRole("admin"));

router.get("/stats", dashboardStats);
router.get("/transactions", listTransactions);
router.get("/reviews", listReviews);
router.patch(
  "/reviews/:id/hide",
  validateParams(objectIdParamSchema),
  setReviewHidden,
);
router.delete(
  "/reviews/:id",
  validateParams(objectIdParamSchema),
  deleteReview,
);

export default router;
