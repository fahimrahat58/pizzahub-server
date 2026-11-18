import type { Request, Response } from "express";
import { ObjectId, type Document } from "mongodb";
import { z } from "zod";

import { collections } from "../config/database.js";
import { asyncHandler, notFound } from "../utils/errors.js";
import { getPagination, firstString, isValidObjectId } from "../utils/query.js";
import { menuItemDto, orderDto, reviewDto, userDto } from "../utils/serialize.js";
import type { ReviewDoc } from "../types/models.js";

const reviewModerationSchema = z.object({ hidden: z.boolean() }).strict();

export const dashboardStats = asyncHandler(async (_req: Request, res: Response) => {
  const [
    totalUsers,
    totalCustomers,
    totalVendors,
    totalMenuItems,
    pendingMenuItems,
    hiddenMenuItems,
    approvedMenuItems,
    totalOrders,
    totalTransactions,
    recentUsers,
    recentOrders,
    recentMenuItems,
  ] = await Promise.all([
    collections.users().countDocuments({}),
    collections.users().countDocuments({ role: "customer" }),
    collections.users().countDocuments({ role: "vendor" }),
    collections.menuItems().countDocuments({}),
    collections.menuItems().countDocuments({ approvalStatus: "pending" }),
    collections.menuItems().countDocuments({
      $or: [{ approvalStatus: "rejected" }, { isActive: false }],
    }),
    collections.menuItems().countDocuments({
      approvalStatus: "approved",
      isActive: true,
    }),
    collections.orders().countDocuments({}),
    collections.transactions().countDocuments({}),
    collections.users().find({}).sort({ createdAt: -1 }).limit(5).toArray(),
    collections.orders().find({}).sort({ createdAt: -1 }).limit(5).toArray(),
    collections.menuItems().find({}).sort({ createdAt: -1 }).limit(5).toArray(),
  ]);

  res.json({
    success: true,
    stats: {
      totalUsers,
      totalCustomers,
      totalVendors,
      totalMenuItems,
      pendingMenuItems,
      hiddenMenuItems,
      approvedMenuItems,
      totalOrders,
      totalTransactions,
    },
    recentUsers: recentUsers.map(userDto),
    recentOrders: recentOrders.map((order) => orderDto(order)),
    recentMenuItems: recentMenuItems.map((item) => menuItemDto(item)),
  });
});

/** Read-only, paginated list of verified payment transactions. */
export const listTransactions = asyncHandler(
  async (req: Request, res: Response) => {
    const { page, limit } = getPagination(req);
    const search = firstString(req.query.search)?.trim();
    const filter: Document = {};
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.$or = [
        { vendorName: { $regex: escaped, $options: "i" } },
        { vendorEmail: { $regex: escaped, $options: "i" } },
        { stripeEventId: { $regex: escaped, $options: "i" } },
      ];
    }

    const [transactions, total] = await Promise.all([
      collections
        .transactions()
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray(),
      collections.transactions().countDocuments(filter),
    ]);

    res.json({
      success: true,
      transactions: transactions.map((transaction) => ({
        id: transaction._id.toHexString(),
        vendorId: transaction.vendorId,
        vendorName: transaction.vendorName,
        vendorEmail: transaction.vendorEmail,
        plan: transaction.plan,
        billingInterval: transaction.billingInterval ?? null,
        amount: transaction.amount,
        currency: transaction.currency,
        status: transaction.status,
        stripeEventId: transaction.stripeEventId,
        stripeSubscriptionId: transaction.stripeSubscriptionId ?? null,
        description: transaction.description ?? null,
        createdAt: transaction.createdAt,
      })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  },
);

type AdminReviewRow = ReviewDoc & {
  authorEmail?: string | null;
  productName?: string | null;
};

/** Admin-only review moderation list, including hidden reviews. */
export const listReviews = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit } = getPagination(req);
  const search = firstString(req.query.search)?.trim();
  const filter: Document = {};
  if (search) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [
      { comment: { $regex: escaped, $options: "i" } },
      { customerName: { $regex: escaped, $options: "i" } },
    ];
  }

  const [reviews, total] = await Promise.all([
    collections.reviews()
      .aggregate<AdminReviewRow>([
        { $match: filter },
        {
          $lookup: {
            from: "users",
            let: { customerId: "$customerId" },
            pipeline: [
              { $match: { $expr: { $eq: [{ $toString: "$_id" }, "$$customerId"] } } },
              { $project: { name: 1, email: 1 } },
            ],
            as: "author",
          },
        },
        {
          $lookup: {
            from: "menuItems",
            localField: "menuItemId",
            foreignField: "_id",
            pipeline: [{ $project: { name: 1 } }],
            as: "product",
          },
        },
        {
          $addFields: {
            authorEmail: { $arrayElemAt: ["$author.email", 0] },
            productName: { $arrayElemAt: ["$product.name", 0] },
          },
        },
        { $project: { author: 0, product: 0 } },
        { $sort: { createdAt: -1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit },
      ])
      .toArray(),
    collections.reviews().countDocuments(filter),
  ]);

  res.json({
    success: true,
    reviews: reviews.map((review) =>
      reviewDto(review, {
        includeCustomerId: true,
        includeHidden: true,
        customerEmail: review.authorEmail ?? null,
        productName: review.productName ?? null,
      }),
    ),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

export const setReviewHidden = asyncHandler(
  async (req: Request, res: Response) => {
    if (!isValidObjectId(String(req.params.id))) throw notFound("Review not found");
    const { hidden } = reviewModerationSchema.parse(req.body);
    const updated = await collections.reviews().findOneAndUpdate(
      { _id: new ObjectId(String(req.params.id)) },
      { $set: { isHidden: hidden, updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!updated) throw notFound("Review not found");

    res.json({
      success: true,
      message: hidden ? "Review hidden" : "Review restored",
      review: reviewDto(updated, {
        includeCustomerId: true,
        includeHidden: true,
      }),
    });
  },
);

export const deleteReview = asyncHandler(async (req: Request, res: Response) => {
  if (!isValidObjectId(String(req.params.id))) throw notFound("Review not found");
  const deleted = await collections.reviews().findOneAndDelete({
    _id: new ObjectId(String(req.params.id)),
  });
  if (!deleted) throw notFound("Review not found");

  res.json({ success: true, message: "Review deleted by administrator" });
});
