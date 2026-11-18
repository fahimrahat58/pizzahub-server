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
import { firstString, getPagination, isValidObjectId } from "../utils/query.js";
import { reviewDto } from "../utils/serialize.js";
import type { RatingDistribution, ReviewDoc } from "../types/models.js";

const RATING_SCHEMA = z.number().int().min(1).max(5);

/**
 * Reviews are plain text. Strip markup and control characters before storage
 * so a crafted comment cannot inject HTML when rendered anywhere else.
 */
const sanitizeReviewText = (value: string): string =>
  value
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const REVIEW_TEXT_SCHEMA = z
  .string()
  .transform(sanitizeReviewText)
  .pipe(z.string().min(3).max(1000));

const createReviewSchema = z
  .object({
    orderId: z.string().regex(/^[a-fA-F0-9]{24}$/, "Invalid order"),
    menuItemId: z.string().regex(/^[a-fA-F0-9]{24}$/, "Invalid pizza"),
    rating: RATING_SCHEMA,
    comment: REVIEW_TEXT_SCHEMA,
  })
  .strict();

const updateReviewSchema = z
  .object({
    rating: RATING_SCHEMA,
    comment: REVIEW_TEXT_SCHEMA,
  })
  .strict();

const createRestaurantReviewSchema = z
  .object({
    orderId: z.string().regex(/^[a-fA-F0-9]{24}$/, "Invalid order"),
    rating: RATING_SCHEMA,
    comment: REVIEW_TEXT_SCHEMA,
  })
  .strict();

type RatingAggregate = {
  _id: null;
  avg: number;
  count: number;
  five: number;
  four: number;
  three: number;
  two: number;
  one: number;
};

type ReviewWithAuthor = ReviewDoc & {
  authorName?: string | null;
  authorImage?: string | null;
  productName?: string | null;
};

const ratingSummaryPipeline = (match: Document): Document[] => [
  { $match: { ...match, isHidden: { $ne: true } } },
  {
    $group: {
      _id: null,
      avg: { $avg: "$rating" },
      count: { $sum: 1 },
      five: { $sum: { $cond: [{ $eq: ["$rating", 5] }, 1, 0] } },
      four: { $sum: { $cond: [{ $eq: ["$rating", 4] }, 1, 0] } },
      three: { $sum: { $cond: [{ $eq: ["$rating", 3] }, 1, 0] } },
      two: { $sum: { $cond: [{ $eq: ["$rating", 2] }, 1, 0] } },
      one: { $sum: { $cond: [{ $eq: ["$rating", 1] }, 1, 0] } },
    },
  },
];

const ratingSummaryFrom = (row?: RatingAggregate) => {
  const distribution: RatingDistribution = {
    "5": row?.five ?? 0,
    "4": row?.four ?? 0,
    "3": row?.three ?? 0,
    "2": row?.two ?? 0,
    "1": row?.one ?? 0,
  };
  return {
    ratingAvg: row?.avg ? Math.round(row.avg * 10) / 10 : 0,
    reviewCount: row?.count ?? 0,
    ratingDistribution: distribution,
  };
};

// Better Auth user ids are strings in review documents while MongoDB stores
// users._id as an ObjectId, so the lookup must compare string forms.
const authorLookup = {
  $lookup: {
    from: "users",
    let: { customerId: "$customerId" },
    pipeline: [
      { $match: { $expr: { $eq: [{ $toString: "$_id" }, "$$customerId"] } } },
      { $project: { name: 1, image: 1 } },
    ],
    as: "author",
  },
};

const authorFields = {
  $addFields: {
    authorName: {
      $ifNull: [
        { $arrayElemAt: ["$author.name", 0] },
        { $ifNull: ["$customerName", "Pizza lover"] },
      ],
    },
    authorImage: { $arrayElemAt: ["$author.image", 0] },
  },
};

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === 11000;

const privateReviewDto = (review: ReviewDoc) =>
  reviewDto(review, { includeCustomerId: true, includeHidden: true });

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

  const itemId = order.menuItemId.toHexString();
  if (itemId !== data.menuItemId) {
    throw badRequest("This pizza is not part of that order");
  }
  const item = await collections.menuItems().findOne(
    { _id: order.menuItemId },
    { projection: { _id: 1 } },
  );
  if (!item) throw badRequest("This pizza is no longer available for review");

  const now = new Date();
  const review: ReviewDoc = {
    _id: new ObjectId(),
    customerId: req.user!.id,
    customerName: req.user!.name,
    menuItemId: new ObjectId(data.menuItemId),
    orderId: new ObjectId(data.orderId),
    rating: data.rating,
    comment: data.comment,
    isHidden: false,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await collections.reviews().insertOne(review);
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw conflict("You have already reviewed this pizza for that order");
    }
    throw error;
  }

  res.status(201).json({
    success: true,
    message: "Review published",
    review: privateReviewDto(review),
  });
});

export const listMenuItemReviews = asyncHandler(
  async (req: Request, res: Response) => {
    if (!isValidObjectId(String(req.params.id))) throw notFound("Pizza not found");
    const { page, limit } = getPagination(req);
    const menuItemId = new ObjectId(String(req.params.id));
    const filter: Document = { menuItemId, isHidden: { $ne: true } };

    const [reviews, summaryRows, total] = await Promise.all([
      collections.reviews()
        .aggregate<ReviewWithAuthor>([
          { $match: filter },
          authorLookup,
          authorFields,
          { $project: { author: 0 } },
          { $sort: { createdAt: -1 } },
          { $skip: (page - 1) * limit },
          { $limit: limit },
        ])
        .toArray(),
      collections.reviews().aggregate<RatingAggregate>(ratingSummaryPipeline({ menuItemId })).toArray(),
      collections.reviews().countDocuments(filter),
    ]);

    res.json({
      success: true,
      reviews: reviews.map((review) => ({
        ...reviewDto(review),
        authorName: review.authorName ?? "Pizza lover",
        authorImage: review.authorImage ?? null,
      })),
      summary: ratingSummaryFrom(summaryRows[0]),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  },
);

/** Customer's own reviews, used to decide between create and edit in the UI. */
export const listMyReviews = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit } = getPagination(req);
  const orderId = firstString(req.query.orderId);
  const menuItemId = firstString(req.query.menuItemId);
  const filter: Document = {
    customerId: req.user!.id,
    menuItemId: { $type: "objectId" },
  };
  if (orderId) {
    if (!isValidObjectId(orderId)) throw badRequest("Invalid order");
    filter.orderId = new ObjectId(orderId);
  }
  if (menuItemId) {
    if (!isValidObjectId(menuItemId)) throw badRequest("Invalid pizza");
    filter.menuItemId = new ObjectId(menuItemId);
  }

  const productLookup = {
    $lookup: {
      from: "menuItems",
      localField: "menuItemId",
      foreignField: "_id",
      pipeline: [{ $project: { name: 1 } }],
      as: "product",
    },
  };

  const [reviews, total] = await Promise.all([
    collections.reviews()
      .aggregate<ReviewWithAuthor>([
        { $match: filter },
        productLookup,
        {
          $addFields: {
            productName: { $arrayElemAt: ["$product.name", 0] },
          },
        },
        { $project: { product: 0 } },
        { $sort: { updatedAt: -1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit },
      ])
      .toArray(),
    collections.reviews().countDocuments(filter),
  ]);

  res.json({
    success: true,
    reviews: reviews.map((review) => ({
      ...privateReviewDto(review),
      productName: review.productName ?? null,
      authorName: review.authorName ?? "Pizza lover",
    })),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

export const updateReview = asyncHandler(async (req: Request, res: Response) => {
  if (req.user!.role !== "customer") {
    throw forbidden("Only customers can manage reviews");
  }
  if (!isValidObjectId(String(req.params.id))) throw notFound("Review not found");
  const data = updateReviewSchema.parse(req.body);
  const reviewId = new ObjectId(String(req.params.id));

  const review = await collections.reviews().findOne({
    _id: reviewId,
    customerId: req.user!.id,
    menuItemId: { $type: "objectId" },
  });
  if (!review) throw notFound("Review not found");

  const order = await collections.orders().findOne({
    _id: review.orderId,
    customerId: req.user!.id,
    status: "delivered",
    menuItemId: review.menuItemId,
  });
  if (!order) throw badRequest("This review can no longer be edited");

  const updated = await collections.reviews().findOneAndUpdate(
    {
      _id: reviewId,
      customerId: req.user!.id,
      menuItemId: { $type: "objectId" },
    },
    {
      $set: {
        rating: data.rating,
        comment: data.comment,
        customerName: review.customerName ?? req.user!.name,
        updatedAt: new Date(),
      },
    },
    { returnDocument: "after" },
  );
  if (!updated) throw notFound("Review not found");

  res.json({
    success: true,
    message: "Review updated",
    review: privateReviewDto(updated),
  });
});

export const deleteReview = asyncHandler(async (req: Request, res: Response) => {
  if (req.user!.role !== "customer") {
    throw forbidden("Only customers can manage reviews");
  }
  if (!isValidObjectId(String(req.params.id))) throw notFound("Review not found");

  const deleted = await collections.reviews().findOneAndDelete({
    _id: new ObjectId(String(req.params.id)),
    customerId: req.user!.id,
    menuItemId: { $type: "objectId" },
  });
  if (!deleted) throw notFound("Review not found");

  res.json({ success: true, message: "Review removed" });
});

/** Vendor-only view of reviews attached to menu items they own. */
export const listVendorReviews = asyncHandler(
  async (req: Request, res: Response) => {
    if (req.user!.role !== "vendor") {
      throw forbidden("Only vendors can view vendor reviews");
    }
    const { page, limit } = getPagination(req);
    const menuItemId = firstString(req.query.menuItemId);
    const productFilter: Document = { vendorId: req.user!.id };
    if (menuItemId) {
      if (!isValidObjectId(menuItemId)) throw badRequest("Invalid pizza");
      productFilter._id = new ObjectId(menuItemId);
    }

    const products = await collections.menuItems()
      .find(productFilter, { projection: { name: 1 } })
      .toArray();
    const productNames = new Map(
      products.map((product) => [product._id.toHexString(), product.name]),
    );
    const filter: Document = {
      menuItemId: { $in: products.map((product) => product._id) },
    };

    const [reviews, total] = await Promise.all([
      collections.reviews()
        .aggregate<ReviewWithAuthor>([
          { $match: filter },
          authorLookup,
          authorFields,
          { $project: { author: 0 } },
          { $sort: { createdAt: -1 } },
          { $skip: (page - 1) * limit },
          { $limit: limit },
        ])
        .toArray(),
      collections.reviews().countDocuments(filter),
    ]);

    res.json({
      success: true,
      reviews: reviews.map((review) => ({
        ...reviewDto(review, {
          includeHidden: true,
          productName: review.menuItemId
            ? productNames.get(review.menuItemId.toHexString()) ?? null
            : null,
        }),
        authorName: review.authorName ?? "Pizza lover",
        authorImage: review.authorImage ?? null,
      })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  },
);

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
      customerName: req.user!.name,
      restaurantId: restaurant._id,
      orderId: new ObjectId(data.orderId),
      rating: data.rating,
      comment: data.comment,
      isHidden: false,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await collections.reviews().insertOne(review);
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw conflict("You have already reviewed this restaurant for that order");
      }
      throw error;
    }

    res.status(201).json({
      success: true,
      message: "Restaurant review published",
      review: privateReviewDto(review),
    });
  },
);

export const listRestaurantReviews = asyncHandler(
  async (req: Request, res: Response) => {
    if (!isValidObjectId(String(req.params.id))) throw notFound("Restaurant not found");
    const { page, limit } = getPagination(req);
    const restaurantId = new ObjectId(String(req.params.id));
    const filter: Document = { restaurantId, isHidden: { $ne: true } };

    const [reviews, total] = await Promise.all([
      collections.reviews()
        .aggregate<ReviewWithAuthor>([
          { $match: filter },
          authorLookup,
          authorFields,
          { $project: { author: 0 } },
          { $sort: { createdAt: -1 } },
          { $skip: (page - 1) * limit },
          { $limit: limit },
        ])
        .toArray(),
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
