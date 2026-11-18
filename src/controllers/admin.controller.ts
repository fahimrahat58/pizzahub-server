import type { Request, Response } from "express";

import { collections } from "../config/database.js";
import { asyncHandler } from "../utils/errors.js";
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
    recentUsers,
    recentOrders,
    recentMenuItems,
  ] = await Promise.all([
    collections.users().countDocuments({}),
    collections.users().countDocuments({ role: "customer" }),
    collections.users().countDocuments({ role: "vendor" }),
    collections.menuItems().countDocuments({}),
    // Kept for older clients; new items are never pending.
    collections.menuItems().countDocuments({ approvalStatus: "pending" }),
    collections.menuItems().countDocuments({
      $or: [{ approvalStatus: "rejected" }, { isActive: false }],
    }),
    collections.menuItems().countDocuments({
      approvalStatus: "approved",
      isActive: true,
    }),
    collections.orders().countDocuments({}),
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
    },
    recentUsers: recentUsers.map(userDto),
    recentOrders: recentOrders.map((order) => orderDto(order)),
    recentMenuItems: recentMenuItems.map((item) => menuItemDto(item)),
  });
});
