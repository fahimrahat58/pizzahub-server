import { ObjectId } from "mongodb";

import { collections } from "./database.js";
import type { MenuItemDoc, TransactionDoc } from "../types/models.js";

/**
 * Brings legacy menu data in line with the current rules:
 * - items awaiting admin approval stay pending and hidden;
 * - an item is only active when it is approved and has a restaurant that really
 *   belongs to its vendor;
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

    // Preserve the review state. Pending items remain hidden until an admin
    // approves them; rejected items stay hidden as well.
    const nextApprovalStatus = item.approvalStatus ?? "pending";
    const nextActive =
      Boolean(validRestaurantId) &&
      nextApprovalStatus === "approved" &&
      item.isActive;
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

const CHECKOUT_INVOICE_MATCH_WINDOW_MS = 60_000;
const CHECKOUT_DESCRIPTION = "Checkout completed";
const PAID_INVOICE_DESCRIPTION = "Renewal payment succeeded";

/**
 * Older webhook releases stored both the checkout event and the first paid
 * invoice for one subscription payment. Keep the invoice row (the authoritative
 * payment record) and remove only the paired rows created within a short
 * window. Separate renewals and failed attempts are never merged.
 */
export const migrateDuplicateTransactions = async (): Promise<void> => {
  const rows = await collections
    .transactions()
    .find({ stripeSubscriptionId: { $exists: true, $ne: null } })
    .sort({ createdAt: 1 })
    .toArray();

  const groups = new Map<string, TransactionDoc[]>();
  for (const row of rows) {
    if (!row.stripeSubscriptionId) continue;
    const key = [
      row.vendorId,
      row.stripeSubscriptionId,
      row.currency,
      row.amount,
    ].join("|");
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  const duplicateIds = new Set<string>();
  for (const group of groups.values()) {
    const checkouts = group.filter(
      (row) => row.description === CHECKOUT_DESCRIPTION,
    );
    for (const checkout of checkouts) {
      const cluster = group.filter(
        (row) =>
          Math.abs(row.createdAt.getTime() - checkout.createdAt.getTime()) <=
            CHECKOUT_INVOICE_MATCH_WINDOW_MS &&
          (row.description === CHECKOUT_DESCRIPTION ||
            row.description === PAID_INVOICE_DESCRIPTION),
      );
      const paidInvoices = cluster.filter(
        (row) => row.description === PAID_INVOICE_DESCRIPTION,
      );
      if (paidInvoices.length === 0) continue;

      const keep = paidInvoices[paidInvoices.length - 1];
      for (const row of cluster) {
        if (!row._id.equals(keep._id)) duplicateIds.add(row._id.toHexString());
      }
    }
  }

  if (duplicateIds.size === 0) return;

  await collections.transactions().deleteMany({
    _id: { $in: [...duplicateIds].map((id) => new ObjectId(id)) },
  });
};
