import { Router } from "express";

import {
  createMyRestaurant,
  deleteMyRestaurant,
  getRestaurant,
  listMyRestaurants,
  listRestaurants,
  patchMyRestaurant,
  restaurantAvailabilitySchema,
  restaurantPatchSchema,
  restaurantSchemaBody,
  saveMyRestaurant,
  setMyRestaurantAvailability,
  updateMyRestaurant,
} from "../controllers/restaurants.controller.js";
import { requireRole, verifyToken } from "../middleware/auth.middleware.js";
import { validateBody } from "../middleware/validate.js";

const router = Router();

router.get("/", listRestaurants);
router.get("/mine", verifyToken, requireRole("vendor"), listMyRestaurants);
router.post(
  "/mine",
  verifyToken,
  requireRole("vendor"),
  validateBody(restaurantSchemaBody),
  createMyRestaurant,
);
router.put(
  "/mine",
  verifyToken,
  requireRole("vendor"),
  validateBody(restaurantSchemaBody),
  saveMyRestaurant,
);
router.patch(
  "/mine/:id/availability",
  verifyToken,
  requireRole("vendor"),
  validateBody(restaurantAvailabilitySchema),
  setMyRestaurantAvailability,
);
router.put(
  "/mine/:id",
  verifyToken,
  requireRole("vendor"),
  validateBody(restaurantSchemaBody),
  updateMyRestaurant,
);
router.patch(
  "/mine/:id",
  verifyToken,
  requireRole("vendor"),
  validateBody(restaurantPatchSchema),
  patchMyRestaurant,
);
router.delete("/mine", verifyToken, requireRole("vendor"), deleteMyRestaurant);
router.delete(
  "/mine/:id",
  verifyToken,
  requireRole("vendor"),
  deleteMyRestaurant,
);
router.get("/:id", getRestaurant);

export default router;
