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
import { menuItemDto } from "../utils/serialize.js";
import {
  canActivateMenuItem,
  menuWithRatingsPipeline,
  restaurantLookup,
} from "../services/menu.service.js";
import type { MenuItemDoc, RestaurantDoc } from "../types/models.js";

const imageUrl = z.url({ message: "A valid image URL is required" });
const objectId = z
  .string()
  .regex(/^[a-fA-F0-9]{24}$/, "Invalid restaurant");
const FREE_LIMIT_MESSAGE =
  "Free vendors can have a maximum of 3 active menu items. Upgrade to Premium to add more.";

export const createMenuItemSchema = z
  .object({
    restaurantId: objectId.optional(),
    name: z.string().trim().min(3).max(100),
    description: z.string().trim().min(10).max(1000),
    category: z.string().trim().min(2).max(40),
    price: z.number().positive().max(1000),
    ingredients: z.array(z.string().trim().min(1).max(60)).min(1).max(30),
    // Menu items no longer ask for a location; the owning restaurant's address
    // remains the location source. Kept optional for older clients and data.
    location: z.string().trim().max(100).optional(),
    image: imageUrl,
    images: z.array(imageUrl).max(6).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

// Zod 4 .partial() preserves the strict catchall from createMenuItemSchema.
export const updateMenuItemSchema = createMenuItemSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "No menu item changes provided",
  });

export const approvalSchema = z
  .object({
    approvalStatus: z.enum(["approved", "rejected"]),
    isActive: z.boolean().optional(),
    isFeatured: z.boolean().optional(),
    rejectionReason: z.string().trim().max(300).optional(),
  })
  .strict();

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Category filters ignore case and variable whitespace (including around "/")
 * so the canonical homepage values match legacy/manually entered categories.
 */
const categoryMatcher = (value: string) =>
  new RegExp(`^${escapeRegex(value.trim()).replace(/\s+/g, "\\s*")}$`, "i");

/** Keeps the cover photo first and caps the gallery at six unique images. */
const buildGallery = (cover: string, extra: string[] = []): string[] =>
  [...new Set([cover, ...extra.filter((url) => url !== cover)])].slice(0, 6);

const parseNumber = (value: unknown): number | undefined => {
  const text = firstString(value);
  if (text === undefined || text === "") return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const publicFilter = (): Document => ({
  approvalStatus: "approved",
  isActive: true,
});

const restaurantSummary = (restaurant: RestaurantDoc) => ({
  id: restaurant._id.toHexString(),
  name: restaurant.name,
  address: restaurant.address,
  image: restaurant.image,
  openingHours: restaurant.openingHours ?? null,
});

const findOwnedRestaurant = async (
  vendorId: string,
  requestedId?: string | null,
): Promise<RestaurantDoc> => {
  if (requestedId) {
    if (!isValidObjectId(requestedId)) {
      throw badRequest("Select a valid restaurant for this menu item");
    }
    const restaurant = await collections.restaurants().findOne({
      _id: new ObjectId(requestedId),
    });
    if (!restaurant) throw notFound("Restaurant not found");
    if (restaurant.vendorId !== vendorId) {
      throw forbidden("You do not manage this restaurant");
    }
    return restaurant;
  }

  const restaurants = await collections
    .restaurants()
    .find({ vendorId })
    .sort({ createdAt: 1 })
    .toArray();
  if (restaurants.length === 0) {
    throw conflict("Add a restaurant before creating menu items");
  }
  if (restaurants.length > 1) {
    throw badRequest("Select which restaurant this menu item belongs to");
  }
  return restaurants[0];
};

const requireOwnedMenuItem = async (
  itemId: ObjectId,
  vendorId: string,
): Promise<MenuItemDoc> => {
  const item = await collections.menuItems().findOne({ _id: itemId });
  if (!item) throw notFound("Pizza not found");
  if (item.vendorId !== vendorId) {
    throw forbidden("You do not manage this pizza");
  }
  return item;
};

const assertCanPublish = async (
  vendorId: string,
  itemId?: ObjectId,
): Promise<void> => {
  const allowed = await canActivateMenuItem(vendorId, itemId);
  if (!allowed) throw conflict(FREE_LIMIT_MESSAGE);
};

const parseRestaurantFilter = (value: unknown): ObjectId | undefined => {
  const restaurantId = firstString(value)?.trim();
  if (!restaurantId) return undefined;
  if (!isValidObjectId(restaurantId)) throw badRequest("Invalid restaurant filter");
  // Menu documents store restaurantId as an ObjectId; a string filter would
  // silently match nothing on both the public and vendor menu queries.
  return new ObjectId(restaurantId);
};

export const listPublicMenu = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit } = getPagination(req);
  const search = firstString(req.query.search)?.trim() ?? "";
  const category = firstString(req.query.category)?.trim() ?? "";
  const location = firstString(req.query.location)?.trim() ?? "";
  const vendorId = firstString(req.query.vendorId)?.trim() ?? "";
  if (vendorId && !isValidObjectId(vendorId)) {
    throw badRequest("Invalid vendor filter");
  }
  const restaurantId = parseRestaurantFilter(req.query.restaurantId);
  const minPrice = parseNumber(req.query.minPrice);
  const maxPrice = parseNumber(req.query.maxPrice);
  const featured = firstString(req.query.featured) === "true";
  const sortBy = firstString(req.query.sort) ?? "newest";

  const filter: Document = { ...publicFilter() };
  const orConditions: Document[] = [];
  if (search) {
    const expression = { $regex: escapeRegex(search), $options: "i" };
    orConditions.push(
      { name: expression },
      { description: expression },
      { ingredients: expression },
    );
  }
  if (category) filter.category = categoryMatcher(category);
  // New items store their own area / city. Legacy items inherit the
  // restaurant address, so both sources must participate in the filter.
  if (location) {
    const expression = { $regex: escapeRegex(location), $options: "i" };
    const matchingRestaurants = await collections
      .restaurants()
      .find({ address: expression }, { projection: { _id: 1 } })
      .toArray();
    orConditions.push(
      { location: expression },
      { restaurantId: { $in: matchingRestaurants.map((restaurant) => restaurant._id) } },
    );
  }
  if (orConditions.length > 0) filter.$or = orConditions;
  if (vendorId) filter.vendorId = vendorId;
  if (restaurantId) filter.restaurantId = restaurantId;
  if (minPrice !== undefined || maxPrice !== undefined) {
    filter.price = {
      ...(minPrice !== undefined ? { $gte: minPrice } : {}),
      ...(maxPrice !== undefined ? { $lte: maxPrice } : {}),
    };
  }
  if (featured) filter.isFeatured = true;

  const sort: Document =
    sortBy === "price_asc"
      ? { price: 1 }
      : sortBy === "price_desc"
        ? { price: -1 }
        : sortBy === "rating"
          ? { ratingAvg: -1, createdAt: -1 }
          : sortBy === "oldest"
            ? { createdAt: 1 }
            : { createdAt: -1 };

  const pipeline = menuWithRatingsPipeline(
    filter,
    sort,
    (page - 1) * limit,
    limit,
    { premiumFirst: true },
  );
  const [items, total] = await Promise.all([
    collections.menuItems().aggregate<MenuItemDoc>(pipeline).toArray(),
    collections.menuItems().countDocuments(filter),
  ]);

  res.json({
    success: true,
    items: items.map((item) => menuItemDto(item, item)),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

export const getPublicMenuItem = asyncHandler(
  async (req: Request, res: Response) => {
    if (!isValidObjectId(String(req.params.id))) throw notFound("Pizza not found");
    const objectIdValue = new ObjectId(String(req.params.id));

    // Public discovery only. Admin/vendor privileged visibility belongs on
    // /api/menu/admin/* and /api/menu/vendor/mine, never on this route.
    const filter: Document = { _id: objectIdValue, ...publicFilter() };

    const [item] = await collections
      .menuItems()
      .aggregate<MenuItemDoc>(menuWithRatingsPipeline(filter, {}, 0, 1))
      .toArray();

    if (!item) throw notFound("Pizza not found");
    res.json({ success: true, item: menuItemDto(item, item) });
  },
);

export const listVendorMenu = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit } = getPagination(req);
  const status = firstString(req.query.status);
  const restaurantId = parseRestaurantFilter(req.query.restaurantId);
  const filter: Document = { vendorId: req.user!.id };
  if (status && ["pending", "approved", "rejected"].includes(status)) {
    filter.approvalStatus = status;
  }
  if (restaurantId) filter.restaurantId = restaurantId;

  const pipeline = menuWithRatingsPipeline(
    filter,
    { createdAt: -1 },
    (page - 1) * limit,
    limit,
  );
  const [items, total] = await Promise.all([
    collections.menuItems().aggregate<MenuItemDoc>(pipeline).toArray(),
    collections.menuItems().countDocuments(filter),
  ]);

  res.json({
    success: true,
    items: items.map((item) => menuItemDto(item, item)),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

export const createMenuItem = asyncHandler(async (req: Request, res: Response) => {
  const data = createMenuItemSchema.parse(req.body);
  const restaurant = await findOwnedRestaurant(
    req.user!.id,
    data.restaurantId,
  );

  // New items always start pending and hidden. An administrator must approve
  // them before they become visible and orderable on the public menu.
  const { restaurantId: _restaurantId, isActive: _isActive, ...itemData } = data;
  const now = new Date();
  const document: MenuItemDoc = {
    _id: new ObjectId(),
    vendorId: req.user!.id,
    restaurantId: restaurant._id,
    ...itemData,
    location: data.location ?? "",
    images: buildGallery(data.image, data.images),
    approvalStatus: "pending",
    // Force hidden regardless of any client-supplied isActive value.
    isActive: false,
    isFeatured: false,
    createdAt: now,
    updatedAt: now,
  };

  await collections.menuItems().insertOne(document);
  res.status(201).json({
    success: true,
    message: "Pizza submitted for admin approval",
    item: menuItemDto(document, { restaurant: restaurantSummary(restaurant) }),
  });
});

export const updateMenuItem = asyncHandler(async (req: Request, res: Response) => {
  if (!isValidObjectId(String(req.params.id))) throw notFound("Pizza not found");
  const data = updateMenuItemSchema.parse(req.body);
  const itemId = new ObjectId(String(req.params.id));

  const existing = await requireOwnedMenuItem(itemId, req.user!.id);

  const requestedRestaurantId =
    data.restaurantId ?? existing.restaurantId?.toHexString() ?? null;
  if (!requestedRestaurantId) {
    throw badRequest("Select a restaurant for this menu item");
  }
  const restaurant = await findOwnedRestaurant(
    req.user!.id,
    requestedRestaurantId,
  );

  // Only administrators can approve pending items or restore rejected ones.
  if (data.isActive === true && existing.approvalStatus !== "approved") {
    throw conflict(
      "This item is awaiting admin approval. Only an administrator can publish it.",
    );
  }
  if (data.isActive === true && existing.approvalStatus === "approved") {
    await assertCanPublish(req.user!.id, itemId);
  }

  const { restaurantId: _restaurantId, isActive: _isActive, ...changes } = data;
  if (changes.image !== undefined || changes.images !== undefined) {
    changes.images = buildGallery(
      changes.image ?? existing.image,
      changes.images ?? existing.images ?? [],
    );
  }
  const item = await collections.menuItems().findOneAndUpdate(
    { _id: itemId, vendorId: req.user!.id },
    {
      $set: {
        ...changes,
        restaurantId: restaurant._id,
        updatedAt: new Date(),
      },
    },
    { returnDocument: "after" },
  );
  if (!item) throw notFound("Pizza not found");

  res.json({
    success: true,
    item: menuItemDto(item, { restaurant: restaurantSummary(restaurant) }),
  });
});

export const deleteMenuItem = asyncHandler(async (req: Request, res: Response) => {
  if (!isValidObjectId(String(req.params.id))) throw notFound("Pizza not found");
  const itemId = new ObjectId(String(req.params.id));
  await requireOwnedMenuItem(itemId, req.user!.id);
  const deleted = await collections.menuItems().deleteOne({
    _id: itemId,
    vendorId: req.user!.id,
  });
  if (deleted.deletedCount === 0) throw notFound("Pizza not found");
  await collections.favorites().deleteMany({ menuItemId: itemId });
  res.json({ success: true, message: "Pizza deleted" });
});

export const toggleMenuItemActive = asyncHandler(
  async (req: Request, res: Response) => {
    if (!isValidObjectId(String(req.params.id))) throw notFound("Pizza not found");
    const { isActive } = z.object({ isActive: z.boolean() }).strict().parse(req.body);
    const itemId = new ObjectId(String(req.params.id));

    const item = await requireOwnedMenuItem(itemId, req.user!.id);

    if (isActive && item.approvalStatus === "rejected") {
      throw conflict("This item was removed by an administrator");
    }
    if (isActive && item.approvalStatus === "pending") {
      throw conflict("This item is awaiting admin approval and cannot be published yet");
    }

    let restaurant: RestaurantDoc | null = null;
    if (isActive) {
      restaurant = await findOwnedRestaurant(
        req.user!.id,
        item.restaurantId?.toHexString() ?? null,
      );
      await assertCanPublish(req.user!.id, itemId);
    }

    const updated = await collections.menuItems().findOneAndUpdate(
      { _id: itemId, vendorId: req.user!.id },
      {
        $set: {
          isActive,
          updatedAt: new Date(),
        },
      },
      { returnDocument: "after" },
    );
    if (!updated) throw notFound("Pizza not found");
    res.json({
      success: true,
      message: isActive ? "Pizza published" : "Pizza unpublished",
      item: menuItemDto(
        updated,
        restaurant ? { restaurant: restaurantSummary(restaurant) } : undefined,
      ),
    });
  },
);

export const listAdminMenu = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit } = getPagination(req);
  const status = firstString(req.query.status);
  const search = firstString(req.query.search)?.trim();
  const filter: Document = {};
  if (status && ["pending", "approved", "rejected"].includes(status)) {
    filter.approvalStatus = status;
  }
  if (search) {
    // Escape regex special characters so search text is treated literally.
    const escaped = escapeRegex(search);
    filter.$or = [
      { name: { $regex: escaped, $options: "i" } },
      { category: { $regex: escaped, $options: "i" } },
      { location: { $regex: escaped, $options: "i" } },
    ];
  }

  const pipeline = menuWithRatingsPipeline(
    filter,
    { createdAt: -1 },
    (page - 1) * limit,
    limit,
  );
  const [items, total] = await Promise.all([
    collections.menuItems().aggregate<MenuItemDoc>(pipeline).toArray(),
    collections.menuItems().countDocuments(filter),
  ]);

  res.json({
    success: true,
    items: items.map((item) => menuItemDto(item, item)),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

export const listPendingMenu = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit } = getPagination(req);
  const filter: Document = { approvalStatus: "pending" };
  const [items, total] = await Promise.all([
    collections
      .menuItems()
      .find(filter)
      .sort({ createdAt: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    collections.menuItems().countDocuments(filter),
  ]);
  res.json({
    success: true,
    items: items.map((item) => menuItemDto(item)),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

export const reviewMenuItem = asyncHandler(async (req: Request, res: Response) => {
  if (!isValidObjectId(String(req.params.id))) throw notFound("Pizza not found");
  const { approvalStatus, isActive, isFeatured, rejectionReason } =
    approvalSchema.parse(req.body);
  const itemId = new ObjectId(String(req.params.id));

  const item = await collections.menuItems().findOne({ _id: itemId });
  if (!item) throw notFound("Pizza not found");

  // Approving a pending submission publishes it by default; hiding/restoring
  // an already-reviewed item keeps its current availability unless overridden.
  const nextActive =
    approvalStatus === "rejected"
      ? false
      : (isActive ??
        (item.approvalStatus === "pending" ? true : item.isActive));

  if (approvalStatus === "approved" && nextActive) {
    if (!item.restaurantId) {
      throw conflict("This item needs a restaurant before it can be listed");
    }
    const restaurant = await collections.restaurants().findOne({
      _id: item.restaurantId,
      vendorId: item.vendorId,
    });
    if (!restaurant) {
      throw conflict("This item's restaurant is no longer available");
    }
    await assertCanPublish(item.vendorId, itemId);
  }

  const updated = await collections.menuItems().findOneAndUpdate(
    { _id: itemId },
    {
      $set: {
        approvalStatus,
        isActive: nextActive,
        isFeatured: isFeatured ?? item.isFeatured,
        rejectionReason:
          approvalStatus === "rejected"
            ? (rejectionReason ?? "Removed by an administrator")
            : null,
        updatedAt: new Date(),
      },
    },
    { returnDocument: "after" },
  );
  if (!updated) throw notFound("Pizza not found");

  res.json({
    success: true,
    message:
      approvalStatus === "approved"
        ? item.approvalStatus === "pending"
          ? "Pizza approved and published"
          : "Pizza restored"
        : "Pizza hidden",
    item: menuItemDto(updated),
  });
});

export const adminDeleteMenuItem = asyncHandler(
  async (req: Request, res: Response) => {
    if (!isValidObjectId(String(req.params.id))) throw notFound("Pizza not found");
    const itemId = new ObjectId(String(req.params.id));
    const deleted = await collections.menuItems().findOneAndDelete({
      _id: itemId,
    });
    if (!deleted) throw notFound("Pizza not found");
    // Order snapshots and reviews are historical records and are preserved.
    await collections.favorites().deleteMany({ menuItemId: itemId });
    res.json({ success: true, message: "Pizza deleted by administrator" });
  },
);

export const getFeaturedMenu = asyncHandler(async (_req: Request, res: Response) => {
  const items = await collections
    .menuItems()
    .aggregate<MenuItemDoc>(
      menuWithRatingsPipeline(
        publicFilter(),
        { isFeatured: -1, createdAt: -1 },
        0,
        8,
        { featuredPlacement: true, premiumFirst: true },
      ),
    )
    .toArray();
  res.json({ success: true, items: items.map((item) => menuItemDto(item, item)) });
});

export const listCategories = asyncHandler(async (_req: Request, res: Response) => {
  const categories = await collections
    .menuItems()
    .distinct("category", publicFilter());
  res.json({ success: true, categories: categories.sort() });
});

export const listLocations = asyncHandler(async (_req: Request, res: Response) => {
  const rows = await collections
    .menuItems()
    .aggregate<Document>([
      { $match: publicFilter() },
      restaurantLookup,
      {
        $project: {
          _id: 0,
          location: {
            $cond: [
              { $gt: [{ $strLenCP: { $ifNull: ["$location", ""] } }, 0] },
              "$location",
              { $ifNull: [{ $arrayElemAt: ["$restaurantInfo.address", 0] }, ""] },
            ],
          },
        },
      },
    ])
    .toArray();
  const locations = [
    ...new Set(
      rows
        .map((row) => String(row.location ?? "").trim())
        .filter((value) => value.length > 0),
    ),
  ];
  res.json({
    success: true,
    locations: locations.sort((a, b) => a.localeCompare(b)),
  });
});
