import { ObjectId, type Document } from "mongodb";

import { collections } from "../config/database.js";
import {
  FREE_ITEM_LIMIT,
  isPremiumUser,
  SUBSCRIPTION_STATE_PROJECTION,
} from "./subscription.service.js";

export { FREE_ITEM_LIMIT };

/** Free vendors may not exceed three approved + active menu items. */
export const canActivateMenuItem = async (
  vendorId: string,
  excludeId?: ObjectId,
): Promise<boolean> => {
  const vendor = await collections.users().findOne(
    { _id: new ObjectId(vendorId) },
    { projection: SUBSCRIPTION_STATE_PROJECTION },
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
          endedAt: 1,
          canceledAt: 1,
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
    // Mirrors getEffectiveSubscription() from the same trusted MongoDB fields:
    // premium/pro plan, active or trialing status (legacy no-status plans
    // count as active), not expired, and not ended.
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
            { $eq: [{ $ifNull: ["$$vendor.endedAt", null] }, null] },
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
      // Admin-hidden reviews must not influence public product ratings.
      { $match: { isHidden: { $ne: true } } },
      {
        $group: {
          _id: null,
          avg: { $avg: "$rating" },
          count: { $sum: 1 },
          five: { $sum: { $cond: [{ $eq: ["$rating", 5] }, 1, 0] } },
          four: { $sum: { $cond: [{ $eq: ["$rating", 4] }, 1, 0] } },
          three: { $sum: { $cond: [{ $eq: ["$rating", 3] }, 1, 0] } },
          two: { $sum: { $cond: [{ $eq: ["$rating", 2] }, 1, 0] } },
          one: { $sum: { $cond: [{ $eq: ["$rating", 1] }, 1, 0] } },
        },
      },
      {
        $project: {
          _id: 0,
          avg: 1,
          count: 1,
          distribution: {
            "5": "$five",
            "4": "$four",
            "3": "$three",
            "2": "$two",
            "1": "$one",
          },
        },
      },
    ],
    as: "ratingInfo",
  },
};

const emptyRatingDistribution = {
  "1": 0,
  "2": 0,
  "3": 0,
  "4": 0,
  "5": 0,
};

const ratingFields = {
  $addFields: {
    ratingAvg: {
      $round: [{ $ifNull: [{ $arrayElemAt: ["$ratingInfo.avg", 0] }, 0] }, 1],
    },
    reviewCount: {
      $ifNull: [{ $arrayElemAt: ["$ratingInfo.count", 0] }, 0],
    },
    ratingDistribution: {
      $ifNull: [
        { $arrayElemAt: ["$ratingInfo.distribution", 0] },
        emptyRatingDistribution,
      ],
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
          isAvailable: 1,
        },
      },
    ],
    as: "restaurantInfo",
  },
};

export type MenuPipelineOptions = {
  /** Prioritises verified Premium vendors while preserving the chosen sort. */
  premiumFirst?: boolean;
  /** Includes Premium items in the existing featured placement listing. */
  featuredPlacement?: boolean;
};

export const menuWithRatingsPipeline = (
  match: Document,
  sort: Document,
  skip: number,
  limit: number,
  options: MenuPipelineOptions = {},
): Document[] => {
  const { premiumFirst = false, featuredPlacement = false } = options;
  const sortStages = Object.keys(sort).length
    ? [
        {
          $sort: premiumFirst
            ? { _premiumPlacement: -1, ...sort, _id: 1 }
            : { ...sort, _id: 1 },
        },
      ]
    : [];

  return [
    { $match: match },
    vendorLookup,
    ratingLookup,
    ratingFields,
    restaurantLookup,
    vendorFields,
    { $project: { ratingInfo: 0, vendorInfo: 0 } },
    ...(featuredPlacement
      ? [{ $match: { $or: [{ isFeatured: true }, { vendorPremium: true }] } }]
      : []),
    ...(premiumFirst
      ? [{ $addFields: { _premiumPlacement: { $cond: ["$vendorPremium", 1, 0] } } }]
      : []),
    ...sortStages,
    ...(premiumFirst ? [{ $project: { _premiumPlacement: 0 } }] : []),
    { $skip: skip },
    { $limit: limit },
  ];
};
