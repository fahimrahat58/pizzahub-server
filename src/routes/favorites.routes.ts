import { Router } from "express";
import { z } from "zod";

import {
  addFavorite,
  getFavoriteIds,
  listFavorites,
  removeFavorite,
} from "../controllers/favorites.controller.js";
import { requireRole, verifyToken } from "../middleware/auth.middleware.js";
import {
  validateBody,
  validateParams,
  objectIdParamSchema,
} from "../middleware/validate.js";

const router = Router();

router.use(verifyToken, requireRole("customer"));

router.get("/ids", getFavoriteIds);
router.get("/", listFavorites);
router.post(
  "/",
  validateBody(
    z.object({
      menuItemId: z.string().regex(/^[a-fA-F0-9]{24}$/, "Invalid pizza"),
    }).strict(),
  ),
  addFavorite,
);
router.delete("/:id", validateParams(objectIdParamSchema), removeFavorite);

export default router;
