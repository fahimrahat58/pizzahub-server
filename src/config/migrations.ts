import { ObjectId } from "mongodb";

import { collections } from "./database.js";
import type { MenuItemDoc } from "../types/models.js";

/**
 * Brings legacy published menu data in line with the current rules:
 * - no menu item stays in the obsolete `pending` state;
 * - an item is only active when it has a restaurant that really belongs to its
 *   vendor;
 * - unusable orphan items with no order/review history are removed;
 * - orders and their snapshots are never modified.
 */
export const migrateMenuPublishing = async (): Promise<void> => {
  const [restaurants, items] = await Promise.all([
    collections
      .restaurants()
      .find({}, { projection: { _id: 1, vendorId: 1 } })
      .toArray(),
    collections.menuItems().find({}).toArray(),
  ]);

  const restaurantIdsByVendor = new Map<string, ObjectId[]>();
  for (const restaurant of restaurants) {
    const ids = restaurantIdsByVendor.get(restaurant.vendorId) ?? [];
    ids.push(restaurant._id);
    restaurantIdsByVendor.set(restaurant.vendorId, ids);
  }

  const orphanIds: ObjectId[] = [];
  const updates: Array<{
    updateOne: {
      filter: { _id: ObjectId };
      update: {
        $set: Partial<MenuItemDoc> & { updatedAt: Date };
      };
    };
  }> = [];

  for (const item of items) {
    const vendorRestaurantIds = restaurantIdsByVendor.get(item.vendorId) ?? [];
    const currentRestaurantId = item.restaurantId;
    const hasValidRestaurant =
      currentRestaurantId instanceof ObjectId &&
      vendorRestaurantIds.some((id) => id.equals(currentRestaurantId));
    const inferredRestaurantId =
      !hasValidRestaurant && vendorRestaurantIds.length === 1
        ? vendorRestaurantIds[0]
        : null;
    const validRestaurantId = hasValidRestaurant
      ? currentRestaurantId
      : inferredRestaurantId;

    const nextApprovalStatus =
      item.approvalStatus === "rejected" ? "rejected" : "approved";
    const nextActive = Boolean(validRestaurantId) && item.isActive;
    const shouldUpdate =
      item.approvalStatus !== nextApprovalStatus ||
      item.isActive !== nextActive ||
      (!hasValidRestaurant && validRestaurantId !== null);

    if (shouldUpdate) {
      updates.push({
        updateOne: {
          filter: { _id: item._id },
          update: {
            $set: {
              approvalStatus: nextApprovalStatus,
              isActive: nextActive,
              ...(validRestaurantId ? { restaurantId: validRestaurantId } : {}),
              updatedAt: new Date(),
            },
          },
        },
      });
    }

    if (!validRestaurantId) orphanIds.push(item._id);
  }

  if (updates.length > 0) {
    await collections.menuItems().bulkWrite(updates, { ordered: false });
  }

  for (const itemId of orphanIds) {
    const [orderCount, reviewCount] = await Promise.all([
      collections.orders().countDocuments({ menuItemId: itemId }, { limit: 1 }),
      collections.reviews().countDocuments({ menuItemId: itemId }, { limit: 1 }),
    ]);
    if (orderCount > 0 || reviewCount > 0) {
      // Keep the item as a hidden historical record so order/review references
      // remain resolvable. It cannot be published until it gets a restaurant.
      continue;
    }
    await Promise.all([
      collections.favorites().deleteMany({ menuItemId: itemId }),
      collections.menuItems().deleteOne({ _id: itemId }),
    ]);
  }
};
