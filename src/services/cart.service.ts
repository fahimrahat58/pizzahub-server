import { ObjectId } from "mongodb";

import { collections } from "../config/database.js";
import { badRequest, conflict, forbidden, notFound } from "../utils/errors.js";
import { isValidObjectId } from "../utils/query.js";
import type { CartDoc, CartItemDoc, MenuItemDoc, RestaurantDoc, UserDoc } from "../types/models.js";

/** Flat delivery fee in USD. Kept server-side so clients cannot alter totals. */
export const DELIVERY_FEE = 2.99;
export const ORDER_CURRENCY = "usd";
const MAX_ITEM_QUANTITY = 20;

export interface OrderableMenuItem {
  item: MenuItemDoc;
  vendor: UserDoc;
  restaurant: RestaurantDoc | null;
  restaurantId: string | null;
  restaurantName: string | null;
}

export interface CartItemDto {
  menuItemId: string;
  name: string;
  image: string;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
  vendorId: string;
  vendorName: string;
  restaurantId: string | null;
  restaurantName: string | null;
}

export interface CartDto {
  items: CartItemDto[];
  itemCount: number;
  subtotal: number;
  deliveryFee: number;
  total: number;
  currency: string;
  restaurantId: string | null;
  restaurantName: string | null;
}

const money = (value: number): number => Math.round(value * 100) / 100;

const idString = (value: ObjectId | null | undefined): string | null =>
  value ? value.toHexString() : null;

/** Reuses the same availability rules as the existing single-item order flow. */
export const getOrderableMenuItem = async (
  menuItemId: string,
  customerId: string,
): Promise<OrderableMenuItem> => {
  if (!isValidObjectId(menuItemId)) throw badRequest("Invalid pizza");
  const item = await collections.menuItems().findOne({
    _id: new ObjectId(menuItemId),
    approvalStatus: "approved",
    isActive: true,
  });
  if (!item) throw notFound("This pizza is not available for ordering");
  if (item.vendorId === customerId) {
    throw forbidden("Vendors cannot order their own menu items");
  }
  if (!Number.isFinite(item.price) || item.price < 0) {
    throw badRequest("This pizza has an invalid price");
  }

  const vendor = await collections.users().findOne({
    _id: new ObjectId(item.vendorId),
  });
  if (!vendor || vendor.isBlocked || vendor.role !== "vendor") {
    throw notFound("This restaurant is currently unavailable");
  }

  const restaurant = item.restaurantId
    ? await collections.restaurants().findOne(
        { _id: item.restaurantId },
        { projection: { name: 1, isAvailable: 1 } },
      )
    : null;
  if (restaurant?.isAvailable === false) {
    throw notFound("This restaurant is currently unavailable");
  }

  return {
    item,
    vendor,
    restaurant,
    restaurantId: idString(item.restaurantId),
    restaurantName: restaurant?.name ?? null,
  };
};

const loadCart = async (customerId: string): Promise<CartDoc | null> =>
  collections.carts().findOne({ _id: customerId });

const saveCart = async (cart: CartDoc): Promise<void> => {
  // `_id` is always the customer id; reading a legacy/partial cart document
  // must never make the next write lose ownership and violate the unique index.
  await collections.carts().updateOne(
    { _id: cart._id },
    {
      $set: {
        customerId: cart._id,
        items: cart.items,
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: cart.createdAt },
    },
    { upsert: true },
  );
};

const emptyCart = (customerId: string, now = new Date()): CartDoc => ({
  _id: customerId,
  customerId,
  items: [],
  createdAt: now,
  updatedAt: now,
});

/** Recalculates every price from MongoDB and drops items no longer orderable. */
export const cartSummary = async (customerId: string): Promise<CartDto> => {
  const stored = await loadCart(customerId);
  const items: CartItemDto[] = [];

  for (const entry of stored?.items ?? []) {
    try {
      const resolved = await getOrderableMenuItem(
        entry.menuItemId.toHexString(),
        customerId,
      );
      const unitPrice = money(resolved.item.price);
      const quantity = Math.min(MAX_ITEM_QUANTITY, Math.max(1, entry.quantity));
      items.push({
        menuItemId: resolved.item._id.toHexString(),
        name: resolved.item.name,
        image: resolved.item.image,
        unitPrice,
        quantity,
        lineTotal: money(unitPrice * quantity),
        vendorId: resolved.item.vendorId,
        vendorName: resolved.vendor.businessName?.trim() || resolved.vendor.name,
        restaurantId: resolved.restaurantId,
        restaurantName: resolved.restaurantName,
      });
    } catch {
      // Menu/restaurant state changed after the item was added. Reads stay
      // side-effect free; mutation endpoints persist the cleaned cart.
    }
  }

  const subtotal = money(items.reduce((sum, item) => sum + item.lineTotal, 0));
  return {
    items,
    itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
    subtotal,
    deliveryFee: items.length ? DELIVERY_FEE : 0,
    total: items.length ? money(subtotal + DELIVERY_FEE) : 0,
    currency: ORDER_CURRENCY,
    restaurantId: items[0]?.restaurantId ?? null,
    restaurantName: items[0]?.restaurantName ?? null,
  };
};

const assertSameRestaurant = (
  cart: CartDoc,
  next: { vendorId: string | null; restaurantId: string | null },
): void => {
  const first = cart.items[0];
  if (!first) return;
  const sameVendor = (first.vendorId ?? null) === next.vendorId;
  const sameRestaurant =
    idString(first.restaurantId ?? null) === next.restaurantId;
  if (!sameVendor || !sameRestaurant) {
    throw conflict(
      "Your cart already contains items from another restaurant. Clear it first.",
    );
  }
};

export const addToCart = async (
  customerId: string,
  menuItemId: string,
  quantity: number,
): Promise<CartDto> => {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_ITEM_QUANTITY) {
    throw badRequest("Quantity must be between 1 and 20");
  }
  const resolved = await getOrderableMenuItem(menuItemId, customerId);
  const now = new Date();
  const cart = (await loadCart(customerId)) ?? emptyCart(customerId, now);
  assertSameRestaurant(cart, {
    vendorId: resolved.item.vendorId,
    restaurantId: resolved.restaurantId,
  });

  const existing = cart.items.find(
    (entry) => entry.menuItemId.toHexString() === resolved.item._id.toHexString(),
  );
  if (existing) {
    existing.quantity = Math.min(
      MAX_ITEM_QUANTITY,
      existing.quantity + quantity,
    );
    existing.updatedAt = now;
  } else {
    const next: CartItemDoc = {
      menuItemId: resolved.item._id,
      restaurantId: resolved.item.restaurantId ?? null,
      vendorId: resolved.item.vendorId,
      quantity,
      addedAt: now,
      updatedAt: now,
    };
    cart.items = [...cart.items, next];
  }

  await saveCart(cart);
  return cartSummary(customerId);
};

export const updateCartItem = async (
  customerId: string,
  menuItemId: string,
  quantity: number,
): Promise<CartDto> => {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_ITEM_QUANTITY) {
    throw badRequest("Quantity must be between 1 and 20");
  }
  if (!isValidObjectId(menuItemId)) throw badRequest("Invalid pizza");
  const cart = await loadCart(customerId);
  if (!cart || !cart.items.some((entry) => entry.menuItemId.toHexString() === menuItemId)) {
    throw notFound("This pizza is not in your cart");
  }
  const now = new Date();
  cart.items = cart.items.map((entry) =>
    entry.menuItemId.toHexString() === menuItemId
      ? { ...entry, quantity, updatedAt: now }
      : entry,
  );
  await saveCart(cart);
  return cartSummary(customerId);
};

export const removeCartItem = async (
  customerId: string,
  menuItemId: string,
): Promise<CartDto> => {
  if (!isValidObjectId(menuItemId)) throw badRequest("Invalid pizza");
  const cart = await loadCart(customerId);
  if (!cart || !cart.items.some((entry) => entry.menuItemId.toHexString() === menuItemId)) {
    throw notFound("This pizza is not in your cart");
  }
  cart.items = cart.items.filter(
    (entry) => entry.menuItemId.toHexString() !== menuItemId,
  );
  await saveCart(cart);
  return cartSummary(customerId);
};

export const clearCart = async (customerId: string): Promise<CartDto> => {
  const now = new Date();
  const cart = (await loadCart(customerId)) ?? emptyCart(customerId, now);
  await saveCart({ ...cart, customerId, items: [], updatedAt: now });
  return cartSummary(customerId);
};
