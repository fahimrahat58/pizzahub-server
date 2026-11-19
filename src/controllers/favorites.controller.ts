import type { Request, Response } from "express";
import { ObjectId } from "mongodb";
import { z } from "zod";

import { collections } from "../config/database.js";
import { asyncHandler, forbidden, notFound } from "../utils/errors.js";
import { getPagination, isValidObjectId } from "../utils/query.js";
import { menuItemDto } from "../utils/serialize.js";
import { menuWithRatingsPipeline } from "../services/menu.service.js";
import type { FavoriteDoc, MenuItemDoc } from "../types/models.js";

const favoriteSchema = z.object({
  menuItemId: z.string().regex(/^[a-fA-F0-9]{24}$/, "Invalid pizza"),
}).strict();

const assertCustomer = (req: Request): void => {
  if (req.user!.role !== "customer") {
    throw forbidden("Only customers can manage favorites");
  }
};

export const addFavorite = asyncHandler(async (req: Request, res: Response) => {
  assertCustomer(req);
  const { menuItemId } = favoriteSchema.parse(req.body);
  const objectId = new ObjectId(menuItemId);

  const item = await collections.menuItems().findOne({
    _id: objectId,
    approvalStatus: "approved",
    isActive: true,
  });
  if (!item) throw notFound("Pizza not found");

  await collections.favorites().updateOne(
    { customerId: req.user!.id, menuItemId: objectId },
    {
      $setOnInsert: {
        _id: new ObjectId(),
        customerId: req.user!.id,
        menuItemId: objectId,
        createdAt: new Date(),
      },
    },
    { upsert: true },
  );

  res.status(201).json({ success: true, message: "Added to favorites" });
});

export const removeFavorite = asyncHandler(
  async (req: Request, res: Response) => {
    assertCustomer(req);
    if (!isValidObjectId(String(req.params.id))) throw notFound("Favorite not found");
    const menuItemId = new ObjectId(String(req.params.id));

    const deleted = await collections.favorites().findOneAndDelete({
      customerId: req.user!.id,
      menuItemId,
    });
    if (deleted) {
      res.json({ success: true, message: "Removed from favorites" });
      return;
    }

    const foreign = await collections.favorites().findOne(
      {
        menuItemId,
        customerId: { $ne: req.user!.id },
      },
      { projection: { _id: 1 } },
    );
    if (foreign) throw forbidden("You cannot remove another customer's favorite");
    throw notFound("Favorite not found");
  },
);

export const listFavorites = asyncHandler(async (req: Request, res: Response) => {
  assertCustomer(req);
  const { page, limit } = getPagination(req);

  const favorites = await collections
    .favorites()
    .find({ customerId: req.user!.id })
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .toArray();

  const [items, total] = await Promise.all([
    collections
      .menuItems()
      .aggregate<MenuItemDoc>(
        menuWithRatingsPipeline(
          {
            _id: { $in: favorites.map((favorite) => favorite.menuItemId) },
            approvalStatus: "approved",
            isActive: true,
          },
          { createdAt: -1 },
          0,
          favorites.length || 1,
        ),
      )
      .toArray(),
    collections.favorites().countDocuments({ customerId: req.user!.id }),
  ]);

  res.json({
    success: true,
    items: items.map((item) => menuItemDto(item, item)),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

export const getFavoriteIds = asyncHandler(
  async (req: Request, res: Response) => {
    assertCustomer(req);
    const favorites = await collections
      .favorites()
      .find({ customerId: req.user!.id }, { projection: { menuItemId: 1 } })
      .toArray();
    res.json({
      success: true,
      ids: favorites.map((favorite: FavoriteDoc) =>
        favorite.menuItemId.toHexString(),
      ),
    });
  },
);
