import type { Request, Response } from "express";
import { ObjectId, type Document } from "mongodb";
import { z } from "zod";

import { collections, db } from "../config/database.js";
import {
  asyncHandler,
  badRequest,
  conflict,
  forbidden,
  notFound,
} from "../utils/errors.js";
import {
  getPagination,
  firstString,
  isValidObjectId,
} from "../utils/query.js";
import { userDto } from "../utils/serialize.js";
import type { UserDoc } from "../types/models.js";

export const updateMeSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    businessName: z.string().trim().max(120).nullable().optional(),
    phone: z.string().trim().min(7).max(30).nullable().optional(),
    address: z.string().trim().min(5).max(250).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "No profile changes provided",
  });

export const updateImageSchema = z.object({
  image: z.url({ message: "A valid image URL is required" }),
});

const userIdFilter = (id: string): { _id: ObjectId } => {
  if (!isValidObjectId(id)) throw notFound("User not found");
  return { _id: new ObjectId(id) };
};

const isImgBbUrl = (value: string): boolean => {
  try {
    const host = new URL(value).hostname.toLowerCase();
    // ImgBB serves uploaded images from i.ibb.co, while older records may use
    // imgbb.com. Accept either CDN and its subdomains, but not lookalike hosts.
    return ["imgbb.com", "ibb.co"].some(
      (domain) => host === domain || host.endsWith(`.${domain}`),
    );
  } catch {
    return false;
  }
};

export const getProfile = asyncHandler(async (req: Request, res: Response) => {
  const user = await collections.users().findOne({ _id: new ObjectId(req.user!.id) });
  if (!user) throw notFound("User not found");
  res.json({ success: true, user: userDto(user) });
});

export const updateProfile = asyncHandler(async (req: Request, res: Response) => {
  const data = updateMeSchema.parse(req.body);

  if (data.businessName !== undefined && req.user!.role !== "vendor") {
    throw forbidden("Only vendors can set a business name");
  }

  const update: Partial<UserDoc> = { updatedAt: new Date() };
  if (data.name) update.name = data.name;
  if (data.businessName !== undefined) update.businessName = data.businessName;
  if (data.phone !== undefined) update.phone = data.phone;
  if (data.address !== undefined) update.address = data.address;

  const user = await collections.users().findOneAndUpdate(
    { _id: new ObjectId(req.user!.id) },
    { $set: update },
    { returnDocument: "after" },
  );
  if (!user) throw notFound("User not found");

  res.json({ success: true, user: userDto(user) });
});

export const updateProfileImage = asyncHandler(
  async (req: Request, res: Response) => {
    const { image } = updateImageSchema.parse(req.body);
    if (!isImgBbUrl(image)) {
      throw badRequest("Profile image must be an ImgBB image URL");
    }

    const user = await collections.users().findOneAndUpdate(
      { _id: new ObjectId(req.user!.id) },
      { $set: { image, updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!user) throw notFound("User not found");

    res.json({ success: true, user: userDto(user) });
  },
);

export const adminListUsers = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit } = getPagination(req);
  const search = firstString(req.query.search)?.trim() ?? "";
  const role = firstString(req.query.role);

  const filter = {
    ...(role && ["customer", "vendor", "admin"].includes(role)
      ? { role: role as UserDoc["role"] }
      : {}),
    ...(search
      ? {
          $or: [
            { name: { $regex: search, $options: "i" } },
            { email: { $regex: search, $options: "i" } },
          ],
        }
      : {}),
  };

  const [users, total] = await Promise.all([
    collections
      .users()
      .find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    collections.users().countDocuments(filter),
  ]);

  res.json({
    success: true,
    users: users.map(userDto),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

export const adminGetUser = asyncHandler(async (req: Request, res: Response) => {
  const user = await collections.users().findOne(userIdFilter(String(req.params.id)));
  if (!user) throw notFound("User not found");
  res.json({ success: true, user: userDto(user) });
});

const blockSchema = z.object({ isBlocked: z.boolean() }).strict();
const roleSchema = z.object({ role: z.enum(["customer", "vendor"]) }).strict();

export const adminSetBlocked = asyncHandler(
  async (req: Request, res: Response) => {
    const { isBlocked } = blockSchema.parse(req.body);
    const targetFilter = userIdFilter(String(req.params.id));
    if (String(req.params.id) === req.user!.id) {
      throw forbidden("You cannot block your own account");
    }

    const target = await collections.users().findOne(targetFilter, {
      projection: { role: 1 },
    });
    if (!target) throw notFound("User not found");
    if (target.role === "admin") {
      throw forbidden("Admin accounts cannot be blocked through this endpoint");
    }

    const user = await collections.users().findOneAndUpdate(
      { ...targetFilter, role: { $ne: "admin" } },
      { $set: { isBlocked, updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!user) {
      const current = await collections.users().findOne(targetFilter, {
        projection: { role: 1 },
      });
      if (!current) throw notFound("User not found");
      if (current.role === "admin") {
        throw forbidden("Admin accounts cannot be blocked through this endpoint");
      }
      throw conflict("User state changed during this request");
    }

    res.json({
      success: true,
      message: isBlocked ? "User blocked" : "User unblocked",
      user: userDto(user),
    });
  },
);

export const adminChangeRole = asyncHandler(
  async (req: Request, res: Response) => {
    const { role } = roleSchema.parse(req.body);
    const targetFilter = userIdFilter(String(req.params.id));
    if (String(req.params.id) === req.user!.id) {
      throw forbidden("You cannot change your own role");
    }

    const target = await collections.users().findOne(targetFilter, {
      projection: { role: 1 },
    });
    if (!target) throw notFound("User not found");
    if (target.role === "admin") {
      throw forbidden("Admin accounts cannot be changed through this endpoint");
    }

    const user = await collections.users().findOneAndUpdate(
      { ...targetFilter, role: target.role },
      { $set: { role, updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!user) {
      const current = await collections.users().findOne(targetFilter, {
        projection: { role: 1 },
      });
      if (!current) throw notFound("User not found");
      if (current.role === "admin") {
        throw forbidden("Admin accounts cannot be changed through this endpoint");
      }
      throw conflict("User state changed during this request");
    }

    res.json({
      success: true,
      message: `Role changed to ${role}`,
      user: userDto(user),
    });
  },
);

/**
 * Permanently removes a non-admin account without destroying historical
 * orders. Accounts with order/review history must be blocked instead so those
 * records keep a resolvable customer/vendor reference. Menu items are deleted
 * only when nothing historical depends on them, preventing orphaned items and
 * orphaned restaurants.
 */
export const adminDeleteUser = asyncHandler(
  async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (id === req.user!.id) {
      throw forbidden("You cannot delete your own account");
    }

    const targetFilter = userIdFilter(id);
    const target = await collections.users().findOne(targetFilter);
    if (!target) throw notFound("User not found");
    if (target.role === "admin") {
      throw forbidden("Admin accounts cannot be deleted through this endpoint");
    }

    const targetObjectId = new ObjectId(id);
    const [menuItems, restaurants] = await Promise.all([
      collections
        .menuItems()
        .find({ vendorId: id }, { projection: { _id: 1 } })
        .toArray(),
      collections
        .restaurants()
        .find({ vendorId: id }, { projection: { _id: 1 } })
        .toArray(),
    ]);
    const itemIds = menuItems.map((item) => item._id);
    const restaurantIds = restaurants.map((restaurant) => restaurant._id);

    // A restaurant that somehow contains another vendor's items cannot be
    // removed here; doing so would orphan those menu items.
    const foreignItems = await collections.menuItems().countDocuments(
      {
        restaurantId: { $in: restaurantIds },
        _id: { $not: { $in: itemIds } },
      },
      { limit: 1 },
    );
    if (foreignItems > 0) {
      throw conflict(
        "This account owns restaurants shared with other vendors. Contact support before deleting it.",
      );
    }

    const [orderCount, reviewCount] = await Promise.all([
      collections.orders().countDocuments(
        {
          $or: [
            { customerId: id },
            { vendorId: id },
            ...(itemIds.length > 0 ? [{ menuItemId: { $in: itemIds } }] : []),
          ],
        },
        { limit: 1 },
      ),
      collections.reviews().countDocuments(
        {
          $or: [
            { customerId: id },
            ...(itemIds.length > 0 ? [{ menuItemId: { $in: itemIds } }] : []),
          ],
        },
        { limit: 1 },
      ),
    ]);

    if (orderCount > 0 || reviewCount > 0) {
      throw conflict(
        "This account has order or review history. Block the account instead of deleting it so historical records remain intact.",
      );
    }

    await Promise.all([
      collections
        .favorites()
        .deleteMany({
          $or: [
            { customerId: id },
            ...(itemIds.length > 0 ? [{ menuItemId: { $in: itemIds } }] : []),
          ],
        }),
      collections.menuItems().deleteMany({ vendorId: id }),
      collections.sessions().deleteMany({ userId: targetObjectId }),
      // Better Auth may store account userId as either ObjectId or string.
      db.collection("account").deleteMany({
        $or: [{ userId: targetObjectId }, { userId: id }],
      }),
    ]);
    await collections.restaurants().deleteMany({ vendorId: id });
    const deleted = await collections.users().findOneAndDelete({
      ...targetFilter,
      role: { $ne: "admin" },
    });
    if (!deleted) {
      const current = await collections.users().findOne(targetFilter, {
        projection: { role: 1 },
      });
      if (!current) throw notFound("User not found");
      if (current.role === "admin") {
        throw forbidden("Admin accounts cannot be deleted through this endpoint");
      }
      throw conflict("User state changed during this request");
    }

    res.json({
      success: true,
      message: "User deleted",
      deletedMenuItems: itemIds.length,
      deletedRestaurants: restaurantIds.length,
    });
  },
);

/** Read-only billing overview for admins. No mutation is exposed here. */
export const adminListSubscriptions = asyncHandler(
  async (req: Request, res: Response) => {
    const { page, limit } = getPagination(req);
    const search = firstString(req.query.search)?.trim() ?? "";
    const filter: Document = { role: "vendor" };
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { businessName: { $regex: search, $options: "i" } },
      ];
    }

    const [vendors, total] = await Promise.all([
      collections
        .users()
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray(),
      collections.users().countDocuments(filter),
    ]);

    res.json({
      success: true,
      vendors: vendors.map(userDto),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  },
);

/** Read-only webhook-derived billing history for one vendor. */
export const adminGetSubscriptionHistory = asyncHandler(
  async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const vendor = await collections
      .users()
      .findOne({ ...userIdFilter(id), role: "vendor" });
    if (!vendor) throw notFound("Vendor not found");

    const events = await collections
      .subscriptionEvents()
      .find({ vendorId: id })
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();

    res.json({ success: true, vendor: userDto(vendor), events });
  },
);
