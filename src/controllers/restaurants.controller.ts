import type { Request, Response } from "express";
import { z } from "zod";
import { MongoServerError, ObjectId } from "mongodb";

import { collections } from "../config/database.js";
import {
  RESTAURANT_LIMIT_MESSAGE,
  reserveFreeRestaurantSlot,
} from "../services/restaurant.service.js";
import { asyncHandler, badRequest, conflict, notFound } from "../utils/errors.js";
import { isValidObjectId } from "../utils/query.js";
import { restaurantDto } from "../utils/serialize.js";
import type { RestaurantDoc } from "../types/models.js";

export const restaurantSchemaBody = z
  .object({
    name: z.string().trim().min(2).max(100),
    description: z.string().trim().min(10).max(1000),
    image: z.url(),
    address: z.string().trim().min(5).max(250),
    phone: z.string().trim().min(7).max(30),
    openingHours: z.string().trim().max(120).optional().nullable(),
  })
  .strict();

type RestaurantRating = { ratingAvg: number; reviewCount: number };

const ratingsForRestaurants = async (
  restaurants: RestaurantDoc[],
): Promise<Map<string, RestaurantRating>> => {
  const ratings = new Map<string, RestaurantRating>();
  if (restaurants.length === 0) return ratings;

  const rows = await collections
    .reviews()
    .aggregate<{ _id: ObjectId; ratingAvg: number; reviewCount: number }>([
      { $match: { restaurantId: { $in: restaurants.map((item) => item._id) } } },
      {
        $group: {
          _id: "$restaurantId",
          ratingAvg: { $avg: "$rating" },
          reviewCount: { $sum: 1 },
        },
      },
    ])
    .toArray();

  for (const row of rows) {
    ratings.set(row._id.toHexString(), {
      ratingAvg: Math.round(row.ratingAvg * 10) / 10,
      reviewCount: row.reviewCount,
    });
  }
  return ratings;
};

export const listRestaurants = asyncHandler(async (_req: Request, res: Response) => {
  const restaurants = await collections
    .restaurants()
    .find({})
    .sort({ createdAt: -1 })
    .toArray();
  const ratings = await ratingsForRestaurants(restaurants);
  res.json({
    success: true,
    restaurants: restaurants.map((restaurant) =>
      restaurantDto(restaurant, ratings.get(restaurant._id.toHexString())),
    ),
  });
});

export const getRestaurant = asyncHandler(async (req: Request, res: Response) => {
  if (!isValidObjectId(String(req.params.id))) throw notFound("Restaurant not found");
  const restaurant = await collections
    .restaurants()
    .findOne({ _id: new ObjectId(String(req.params.id)) });
  if (!restaurant) throw notFound("Restaurant not found");
  const ratings = await ratingsForRestaurants([restaurant]);
  res.json({
    success: true,
    restaurant: restaurantDto(restaurant, ratings.get(restaurant._id.toHexString())),
  });
});

export const listMyRestaurants = asyncHandler(
  async (req: Request, res: Response) => {
    const restaurants = await collections
      .restaurants()
      .find({ vendorId: req.user!.id })
      .sort({ createdAt: 1 })
      .toArray();
    const ratings = await ratingsForRestaurants(restaurants);
    const withRatings = restaurants.map((restaurant) =>
      restaurantDto(restaurant, ratings.get(restaurant._id.toHexString())),
    );
    res.json({
      success: true,
      restaurants: withRatings,
      // Backwards-compatible field for older dashboard widgets.
      restaurant: withRatings[0] ?? null,
    });
  },
);

const insertRestaurant = async (
  vendorId: string,
  data: z.infer<typeof restaurantSchemaBody>,
): Promise<RestaurantDoc> => {
  const freeSlot = await reserveFreeRestaurantSlot(vendorId);
  const now = new Date();
  const restaurant: RestaurantDoc = {
    _id: new ObjectId(),
    vendorId,
    ...data,
    openingHours: data.openingHours ?? null,
    ...(freeSlot === null ? {} : { freeSlot }),
    createdAt: now,
    updatedAt: now,
  };
  try {
    await collections.restaurants().insertOne(restaurant);
  } catch (error) {
    // A concurrent request may have claimed the same free slot between the
    // count and the insert. The unique partial index is the final authority.
    if (error instanceof MongoServerError && error.code === 11000) {
      throw conflict(RESTAURANT_LIMIT_MESSAGE);
    }
    throw error;
  }
  return restaurant;
};

export const createMyRestaurant = asyncHandler(
  async (req: Request, res: Response) => {
    const data = restaurantSchemaBody.parse(req.body);
    const restaurant = await insertRestaurant(req.user!.id, data);
    res.status(201).json({
      success: true,
      message: "Restaurant added",
      restaurant: restaurantDto(restaurant),
    });
  },
);

const updateRestaurant = async (
  vendorId: string,
  restaurantId: string | undefined,
  data: z.infer<typeof restaurantSchemaBody>,
): Promise<RestaurantDoc> => {
  if (!restaurantId || !isValidObjectId(restaurantId)) {
    throw badRequest("Select a valid restaurant to update");
  }
  const restaurant = await collections.restaurants().findOneAndUpdate(
    { _id: new ObjectId(restaurantId), vendorId },
    {
      $set: {
        ...data,
        openingHours: data.openingHours ?? null,
        updatedAt: new Date(),
      },
    },
    { returnDocument: "after" },
  );
  if (!restaurant) throw notFound("Restaurant not found");
  return restaurant;
};

export const updateMyRestaurant = asyncHandler(
  async (req: Request, res: Response) => {
    const data = restaurantSchemaBody.parse(req.body);
    const restaurant = await updateRestaurant(
      req.user!.id,
      String(req.params.id ?? req.query.id ?? ""),
      data,
    );
    res.json({
      success: true,
      message: "Restaurant updated",
      restaurant: restaurantDto(restaurant),
    });
  },
);

/** Legacy `PUT /api/restaurants/mine` kept for older saved clients. */
export const saveMyRestaurant = asyncHandler(
  async (req: Request, res: Response) => {
    const data = restaurantSchemaBody.parse(req.body);
    const requestedId = String(req.query.id ?? "");
    if (requestedId) {
      const restaurant = await updateRestaurant(req.user!.id, requestedId, data);
      res.json({
        success: true,
        message: "Restaurant saved",
        restaurant: restaurantDto(restaurant),
      });
      return;
    }

    const existing = await collections
      .restaurants()
      .find({ vendorId: req.user!.id })
      .toArray();
    if (existing.length > 1) {
      throw badRequest("Select which restaurant to update");
    }
    const restaurant =
      existing.length === 1
        ? await updateRestaurant(
            req.user!.id,
            existing[0]._id.toHexString(),
            data,
          )
        : await insertRestaurant(req.user!.id, data);
    res.json({
      success: true,
      message: "Restaurant saved",
      restaurant: restaurantDto(restaurant),
    });
  },
);

/**
 * Deleting a restaurant is only allowed once its menu items have no order or
 * review history. Those items (and their favorites/reviews) are removed with
 * the restaurant so no menu item is left pointing at a deleted restaurant.
 * Orders and their snapshots are never touched.
 */
export const deleteMyRestaurant = asyncHandler(
  async (req: Request, res: Response) => {
    const requestedId = String(req.params.id ?? req.query.id ?? "");
    let restaurantId: ObjectId;

    if (requestedId) {
      if (!isValidObjectId(requestedId)) {
        throw badRequest("Select a valid restaurant to delete");
      }
      restaurantId = new ObjectId(requestedId);
    } else {
      const restaurants = await collections
        .restaurants()
        .find({ vendorId: req.user!.id }, { projection: { _id: 1 } })
        .toArray();
      if (restaurants.length === 0) throw notFound("Restaurant not found");
      if (restaurants.length > 1) {
        throw badRequest("Select which restaurant to delete");
      }
      restaurantId = restaurants[0]._id;
    }

    const restaurant = await collections.restaurants().findOne({
      _id: restaurantId,
      vendorId: req.user!.id,
    });
    if (!restaurant) throw notFound("Restaurant not found");

    const items = await collections
      .menuItems()
      .find(
        { vendorId: req.user!.id, restaurantId },
        { projection: { _id: 1 } },
      )
      .toArray();
    const itemIds = items.map((item) => item._id);

    if (itemIds.length > 0) {
      const [orderCount, reviewCount] = await Promise.all([
        collections.orders().countDocuments({ menuItemId: { $in: itemIds } }, { limit: 1 }),
        collections.reviews().countDocuments({ menuItemId: { $in: itemIds } }, { limit: 1 }),
      ]);
      if (orderCount > 0 || reviewCount > 0) {
        throw conflict(
          "This restaurant has menu items with order or review history. Delete or move those items first; order history is preserved.",
        );
      }
      await Promise.all([
        collections.favorites().deleteMany({ menuItemId: { $in: itemIds } }),
        collections.reviews().deleteMany({ menuItemId: { $in: itemIds } }),
        collections.menuItems().deleteMany({ _id: { $in: itemIds } }),
      ]);
    }

    const deleted = await collections.restaurants().deleteOne({
      _id: restaurantId,
      vendorId: req.user!.id,
    });
    if (deleted.deletedCount === 0) throw notFound("Restaurant not found");

    res.json({
      success: true,
      message: "Restaurant deleted",
      deletedMenuItems: itemIds.length,
    });
  },
);
