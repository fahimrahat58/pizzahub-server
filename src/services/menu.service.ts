import { ObjectId, type Document } from "mongodb";

import { collections } from "../config/database.js";
import {
  FREE_ITEM_LIMIT,
  isPremiumUser,
} from "./subscription.service.js";

export { FREE_ITEM_LIMIT };

/** Free vendors may not exceed three approved + active menu items. */
export const canActivateMenuItem = async (
  vendorId: string,
  excludeId?: ObjectId,
): Promise<boolean> => {
  const vendor = await collections.users().findOne(
    { _id: new ObjectId(vendorId) },
    {
      projection: {
        subscriptionPlan: 1,
        subscriptionStatus: 1,
        subscriptionExpiresAt: 1,
        cancelAtPeriodEnd: 1,
      },
    },
  );

  // Premium is computed from trusted MongoDB subscription state. Inactive or
  // expired subscriptions automatically fall back to the Free limit.
  if (vendor && isPremiumUser(vendor)) return true;

  const activeCount = await collections.menuItems().countDocuments({
    vendorId,
    approvalStatus: "approved",
    isActive: true,
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  });

  return activeCount < FREE_ITEM_LIMIT;
};

/**
 * Joins the owning vendor once per item. It supplies the vendor display name
 * for cards and, from trusted MongoDB subscription state, a `vendorPremium`
 * flag used to prioritise Premium vendors in public listings.
 */
const vendorLookup = {
  $lookup: {
    from: "users",
    let: { vendorId: "$vendorId" },
    pipeline: [
      {
        $match: {
          $expr: {
            $eq: [
              "$_id",
              {
                $convert: {
                  input: "$$vendorId",
                  to: "objectId",
                  onError: null,
                  onNull: null,
                },
              },
            ],
          },
        },
      },
      {
        $project: {
          name: 1,
          subscriptionPlan: 1,
          subscriptionStatus: 1,
          subscriptionExpiresAt: 1,
        },
      },
    ],
    as: "vendorInfo",
  },
};

const vendorFields = {
  $addFields: {
    vendorName: {
      $let: {
        vars: { vendor: { $arrayElemAt: ["$vendorInfo", 0] } },
        in: "$$vendor.name",
      },
    },
    vendorPremium: {
      $let: {
        vars: { vendor: { $arrayElemAt: ["$vendorInfo", 0] } },
        in: {
          $and: [
            {
              $in: [
                { $ifNull: ["$$vendor.subscriptionPlan", "free"] },
                ["premium", "pro"],
              ],
            },
            {
              $in: [
                { $ifNull: ["$$vendor.subscriptionStatus", null] },
                ["active", "trialing", null],
              ],
            },
            {
              $or: [
                { $eq: [{ $ifNull: ["$$vendor.subscriptionExpiresAt", null] }, null] },
                { $gt: ["$$vendor.subscriptionExpiresAt", "$$NOW"] },
              ],
            },
          ],
        },
      },
    },
  },
};

const ratingLookup = {
  $lookup: {
    from: "reviews",
    localField: "_id",
    foreignField: "menuItemId",
    pipeline: [
      {
        $group: {
          _id: null,
          avg: { $avg: "$rating" },
          count: { $sum: 1 },
        },
      },
    ],
    as: "ratingInfo",
  },
};

const ratingFields = {
  $addFields: {
    ratingAvg: {
      $round: [{ $ifNull: [{ $arrayElemAt: ["$ratingInfo.avg", 0] }, 0] }, 1],
    },
    reviewCount: {
      $ifNull: [{ $arrayElemAt: ["$ratingInfo.count", 0] }, 0],
    },
  },
};

/**
 * One join supplies the real restaurant name/location for every menu item in
 * the same aggregation response. This avoids one restaurant query per card.
 */
export const restaurantLookup = {
  $lookup: {
    from: "restaurants",
    localField: "restaurantId",
    foreignField: "_id",
    pipeline: [
      {
        $project: {
          name: 1,
          address: 1,
          image: 1,
          openingHours: 1,
        },
      },
    ],
    as: "restaurantInfo",
  },
};

export const menuWithRatingsPipeline = (
  match: Document,
  sort: Document,
  skip: number,
  limit: number,
  _premiumFirst = false,
): Document[] => [
  { $match: match },
  vendorLookup,
  ratingLookup,
  ratingFields,
  restaurantLookup,
  vendorFields,
  { $project: { ratingInfo: 0, vendorInfo: 0 } },
  ...(Object.keys(sort).length > 0 ? [{ $sort: sort }] : []),
  { $skip: skip },
  { $limit: limit },
];
