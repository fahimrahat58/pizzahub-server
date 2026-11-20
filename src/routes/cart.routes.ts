import { Router } from "express";

import {
  addItem,
  cartValidation,
  changeQuantity,
  emptyCart,
  getCart,
  removeItem,
} from "../controllers/cart.controller.js";
import { requireRole, verifyToken } from "../middleware/auth.middleware.js";

const router = Router();

router.use(verifyToken, requireRole("customer"));

router.get("/", getCart);
router.post("/", cartValidation.addBody, addItem);
router.delete("/", emptyCart);
router.patch("/:id", cartValidation.itemParams, cartValidation.quantityBody, changeQuantity);
router.delete("/:id", cartValidation.itemParams, removeItem);

export default router;
