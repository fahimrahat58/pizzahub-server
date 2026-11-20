import type { Request, Response } from "express";
import { z } from "zod";

import {
  addToCart,
  cartSummary,
  clearCart,
  removeCartItem,
  updateCartItem,
} from "../services/cart.service.js";
import { asyncHandler } from "../utils/errors.js";
import { validateBody, validateParams, objectIdParamSchema } from "../middleware/validate.js";

const quantitySchema = z
  .object({
    quantity: z.number().int().min(1).max(20),
  })
  .strict();

export const addToCartSchema = z
  .object({
    menuItemId: z.string().regex(/^[a-fA-F0-9]{24}$/, "Invalid pizza"),
    quantity: z.number().int().min(1).max(20),
  })
  .strict();

export const getCart = asyncHandler(async (req: Request, res: Response) => {
  res.json({ success: true, cart: await cartSummary(req.user!.id) });
});

export const addItem = asyncHandler(async (req: Request, res: Response) => {
  const { menuItemId, quantity } = addToCartSchema.parse(req.body);
  res.json({
    success: true,
    message: "Added to cart",
    cart: await addToCart(req.user!.id, menuItemId, quantity),
  });
});

export const changeQuantity = asyncHandler(async (req: Request, res: Response) => {
  const { quantity } = quantitySchema.parse(req.body);
  res.json({
    success: true,
    cart: await updateCartItem(
      req.user!.id,
      String(req.params.id),
      quantity,
    ),
  });
});

export const removeItem = asyncHandler(async (req: Request, res: Response) => {
  res.json({
    success: true,
    cart: await removeCartItem(req.user!.id, String(req.params.id)),
  });
});

export const emptyCart = asyncHandler(async (req: Request, res: Response) => {
  res.json({ success: true, cart: await clearCart(req.user!.id) });
});

export const cartValidation = {
  itemParams: validateParams(objectIdParamSchema),
  quantityBody: validateBody(quantitySchema),
  addBody: validateBody(addToCartSchema),
};
