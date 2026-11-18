import type { Request, Response } from "express";
import type { Document } from "mongodb";

import { collections } from "../config/database.js";
import { asyncHandler } from "../utils/errors.js";
import { getPagination, firstString } from "../utils/query.js";
import { menuItemDto, orderDto, userDto } from "../utils/serialize.js";

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
