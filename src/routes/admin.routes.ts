import { Router } from "express";

import {
  dashboardStats,
  deleteReview,
  listReviews,
  listTransactions,
  setReviewHidden,
} from "../controllers/admin.controller.js";
import { requireRole, verifyToken } from "../middleware/auth.middleware.js";

const router = Router();

router.use(verifyToken, requireRole("admin"));

router.get("/stats", dashboardStats);
router.get("/transactions", listTransactions);
router.get("/reviews", listReviews);
router.patch("/reviews/:id/hide", setReviewHidden);
router.delete("/reviews/:id", deleteReview);

export default router;
