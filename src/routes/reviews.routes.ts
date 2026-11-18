import { Router } from "express";

import {
  createReview,
  listMenuItemReviews,
} from "../controllers/reviews.controller.js";
import { requireRole, verifyToken } from "../middleware/auth.middleware.js";

const router = Router();

router.get("/:id", listMenuItemReviews);
router.post("/", verifyToken, requireRole("customer"), createReview);

export default router;
