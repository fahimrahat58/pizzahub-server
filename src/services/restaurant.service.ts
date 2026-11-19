import { ObjectId } from "mongodb";

import { collections } from "../config/database.js";
import { conflict } from "../utils/errors.js";
import {
  FREE_RESTAURANT_LIMIT,
  isPremiumUser,
  SUBSCRIPTION_STATE_PROJECTION,
} from "./subscription.service.js";

export const RESTAURANT_LIMIT_MESSAGE =
  "You have reached the maximum limit of 3 restaurants. Upgrade to Premium to add more restaurants.";

/**
 * Reserves the next free restaurant slot for a vendor. Premium vendors get
 * `null` and are not slot-limited. The unique partial index on
 * `{ vendorId, freeSlot }` makes the count-and-insert sequence safe against
 * concurrent duplicate requests.
 */
export const reserveFreeRestaurantSlot = async (
  vendorId: string,
): Promise<number | null> => {
  const vendor = await collections.users().findOne(
    { _id: new ObjectId(vendorId) },
    { projection: SUBSCRIPTION_STATE_PROJECTION },
  );

  if (vendor && isPremiumUser(vendor)) return null;

  const restaurants = await collections
    .restaurants()
    .find({ vendorId }, { projection: { freeSlot: 1 } })
    .toArray();

  if (restaurants.length >= FREE_RESTAURANT_LIMIT) {
    throw conflict(RESTAURANT_LIMIT_MESSAGE);
  }

  const usedSlots = new Set(
    restaurants
      .map((restaurant) => restaurant.freeSlot)
      .filter((slot): slot is number => typeof slot === "number"),
  );

  for (let slot = 0; slot < FREE_RESTAURANT_LIMIT; slot += 1) {
    if (!usedSlots.has(slot)) return slot;
  }

  throw conflict(RESTAURANT_LIMIT_MESSAGE);
};
