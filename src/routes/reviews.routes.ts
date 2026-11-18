import { Router } from "express";

import {
  createRestaurantReview,
  createReview,
  deleteReview,
  listMenuItemReviews,
  listMyReviews,
  listRestaurantReviews,
  listVendorReviews,
  updateReview,
} from "../controllers/reviews.controller.js";
import { requireRole, verifyToken } from "../middleware/auth.middleware.js";

const router = Router();

// Literal routes are declared before `/:id` so they are not treated as ids.
router.get("/restaurant/:id", listRestaurantReviews);
router.post(
  "/restaurant/:id",
  verifyToken,
  requireRole("customer"),
  createRestaurantReview,
);

router.get("/mine", verifyToken, requireRole("customer"), listMyReviews);
router.patch("/mine/:id", verifyToken, requireRole("customer"), updateReview);
router.delete("/mine/:id", verifyToken, requireRole("customer"), deleteReview);
router.get("/vendor", verifyToken, requireRole("vendor"), listVendorReviews);

router.get("/:id", listMenuItemReviews);
router.post("/", verifyToken, requireRole("customer"), createReview);

export default router;
