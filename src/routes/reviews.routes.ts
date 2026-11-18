import { Router } from "express";

import {
  createRestaurantReview,
  createReview,
  listMenuItemReviews,
  listRestaurantReviews,
} from "../controllers/reviews.controller.js";
import { requireRole, verifyToken } from "../middleware/auth.middleware.js";

const router = Router();

// Restaurant routes are declared before `/:id` so the literal segment is not
// mistaken for a menu item id.
router.get("/restaurant/:id", listRestaurantReviews);
router.post(
  "/restaurant/:id",
  verifyToken,
  requireRole("customer"),
  createRestaurantReview,
);

router.get("/:id", listMenuItemReviews);
router.post("/", verifyToken, requireRole("customer"), createReview);

export default router;
