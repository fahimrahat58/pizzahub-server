import type { Request, Response } from "express";
import { ObjectId, type Document } from "mongodb";
import { z } from "zod";

import { collections } from "../config/database.js";
import {
  asyncHandler,
  badRequest,
  conflict,
  forbidden,
  notFound,
} from "../utils/errors.js";
import { getPagination, isValidObjectId } from "../utils/query.js";
import { reviewDto } from "../utils/serialize.js";
import type { ReviewDoc } from "../types/models.js";

const createReviewSchema = z.object({
  orderId: z.string().regex(/^[a-fA-F0-9]{24}$/, "Invalid order"),
  menuItemId: z.string().regex(/^[a-fA-F0-9]{24}$/, "Invalid pizza"),
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().min(3).max(1000),
});

export const createReview = asyncHandler(async (req: Request, res: Response) => {
  if (req.user!.role !== "customer") {
    throw forbidden("Only customers can write reviews");
  }
  const data = createReviewSchema.parse(req.body);

  const order = await collections.orders().findOne({
    _id: new ObjectId(data.orderId),
    customerId: req.user!.id,
    status: "delivered",
  });
  if (!order) throw badRequest("You can only review pizzas from delivered orders");
  if (order.menuItemId.toHexString() !== data.menuItemId) {
    throw badRequest("This pizza is not part of that order");
  }

  const now = new Date();
  const review: ReviewDoc = {
    _id: new ObjectId(),
    customerId: req.user!.id,
    menuItemId: new ObjectId(data.menuItemId),
    orderId: new ObjectId(data.orderId),
    rating: data.rating,
    comment: data.comment,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await collections.reviews().insertOne(review);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === 11000
    ) {
      throw conflict("You have already reviewed this pizza for that order");
    }
    throw error;
  }

  res.status(201).json({
    success: true,
    message: "Review published",
    review: reviewDto(review),
  });
});

export const listMenuItemReviews = asyncHandler(
  async (req: Request, res: Response) => {
    if (!isValidObjectId(String(req.params.id))) throw notFound("Pizza not found");
    const { page, limit } = getPagination(req);
    const filter: Document = {
      menuItemId: new ObjectId(String(req.params.id)),
    };

    type ReviewWithAuthor = ReviewDoc & {
      authorName?: string;
      authorImage?: string | null;
    };

    const [reviews, total] = await Promise.all([
      collections.reviews().aggregate<ReviewWithAuthor>([
        { $match: filter },
        {
          $lookup: {
            from: "users",
            localField: "customerId",
            foreignField: "_id",
            as: "author",
          },
        },
        {
          $addFields: {
            authorName: { $arrayElemAt: ["$author.name", 0] },
            authorImage: { $arrayElemAt: ["$author.image", 0] },
          },
        },
        { $project: { author: 0 } },
        { $sort: { createdAt: -1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit },
      ]).toArray(),
      collections.reviews().countDocuments(filter),
    ]);

    res.json({
      success: true,
      reviews: reviews.map((review) => ({
        ...reviewDto(review),
        authorName: review.authorName ?? "Pizza lover",
        authorImage: review.authorImage ?? null,
      })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  },
);

const createRestaurantReviewSchema = z.object({
  orderId: z.string().regex(/^[a-fA-F0-9]{24}$/, "Invalid order"),
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().min(3).max(1000),
});

export const createRestaurantReview = asyncHandler(
  async (req: Request, res: Response) => {
    if (req.user!.role !== "customer") {
      throw forbidden("Only customers can write reviews");
    }
    if (!isValidObjectId(String(req.params.id))) throw notFound("Restaurant not found");

    const restaurant = await collections.restaurants().findOne({
      _id: new ObjectId(String(req.params.id)),
    });
    if (!restaurant) throw notFound("Restaurant not found");

    const data = createRestaurantReviewSchema.parse(req.body);
    const order = await collections.orders().findOne({
      _id: new ObjectId(data.orderId),
      customerId: req.user!.id,
      status: "delivered",
    });
    if (!order) throw badRequest("You can only review restaurants from delivered orders");

    const item = await collections
      .menuItems()
      .findOne({ _id: order.menuItemId }, { projection: { restaurantId: 1 } });
    if (
      !item?.restaurantId ||
      item.restaurantId.toHexString() !== restaurant._id.toHexString()
    ) {
      throw badRequest("This order is not from that restaurant");
    }

    const now = new Date();
    const review: ReviewDoc = {
      _id: new ObjectId(),
      customerId: req.user!.id,
      restaurantId: restaurant._id,
      orderId: new ObjectId(data.orderId),
      rating: data.rating,
      comment: data.comment,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await collections.reviews().insertOne(review);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === 11000
      ) {
        throw conflict("You have already reviewed this restaurant for that order");
      }
      throw error;
    }

    res.status(201).json({
      success: true,
      message: "Restaurant review published",
      review: reviewDto(review),
    });
  },
);

export const listRestaurantReviews = asyncHandler(
  async (req: Request, res: Response) => {
    if (!isValidObjectId(String(req.params.id))) throw notFound("Restaurant not found");
    const { page, limit } = getPagination(req);
    const filter: Document = {
      restaurantId: new ObjectId(String(req.params.id)),
    };

    type ReviewWithAuthor = ReviewDoc & {
      authorName?: string;
      authorImage?: string | null;
    };

    const [reviews, total] = await Promise.all([
      collections.reviews().aggregate<ReviewWithAuthor>([
        { $match: filter },
        {
          $lookup: {
            from: "users",
            localField: "customerId",
            foreignField: "_id",
            as: "author",
          },
        },
        {
          $addFields: {
            authorName: { $arrayElemAt: ["$author.name", 0] },
            authorImage: { $arrayElemAt: ["$author.image", 0] },
          },
        },
        { $project: { author: 0 } },
        { $sort: { createdAt: -1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit },
      ]).toArray(),
      collections.reviews().countDocuments(filter),
    ]);

    res.json({
      success: true,
      reviews: reviews.map((review) => ({
        ...reviewDto(review),
        authorName: review.authorName ?? "Pizza lover",
        authorImage: review.authorImage ?? null,
      })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  },
);
