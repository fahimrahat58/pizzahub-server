import type {
  FavoriteDoc,
  MenuItemDoc,
  OrderDoc,
  RestaurantDoc,
  ReviewDoc,
  UserDoc,
} from "../types/models.js";
import { getEffectiveSubscription } from "../services/subscription.service.js";

const id = (value: { _id: { toHexString: () => string } }): string =>
  value._id.toHexString();

export const userDto = (user: UserDoc) => {
  const effective = getEffectiveSubscription(user);

  return {
    id: user._id.toHexString(),
    name: user.name,
    email: user.email,
    image: user.image ?? null,
    role: user.role,
    isBlocked: user.isBlocked ?? false,
    businessName: user.businessName ?? null,
    phone: user.phone ?? null,
    address: user.address ?? null,
    // Legacy `pro` is normalised to `premium` for every API consumer.
    subscriptionPlan: effective.plan,
    subscriptionStatus: effective.status,
    stripeCustomerId: user.stripeCustomerId ?? null,
    stripeSubscriptionId: user.stripeSubscriptionId ?? null,
    subscriptionExpiresAt: effective.expiresAt,
    cancelAtPeriodEnd: effective.cancelAtPeriodEnd,
    isPremium: effective.isPremium,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
};

type RestaurantSummarySource = {
  _id?: { toHexString: () => string } | string;
  id?: string;
  name: string;
  address: string;
  image?: string | null;
  openingHours?: string | null;
};

type MenuEnrichment = {
  ratingAvg?: number;
  reviewCount?: number;
  restaurantInfo?: RestaurantSummarySource[];
  restaurant?: RestaurantSummarySource | null;
  vendorName?: string | null;
};

const restaurantSummary = (
  source?: RestaurantSummarySource | null,
): RestaurantSummarySource | null => {
  if (!source) return null;
  const restaurantId =
    source.id ??
    (typeof source._id === "string"
      ? source._id
      : source._id?.toHexString() ?? null);
  if (!restaurantId) return null;
  return {
    id: restaurantId,
    name: source.name,
    address: source.address,
    image: source.image ?? null,
    openingHours: source.openingHours ?? null,
  };
};

export const menuItemDto = (
  item: MenuItemDoc & MenuEnrichment,
  rating?: Partial<MenuItemDoc> & MenuEnrichment,
) => {
  const enriched = rating ?? item;
  const restaurant = restaurantSummary(
    enriched.restaurantInfo?.[0] ?? enriched.restaurant ?? item.restaurant,
  );
  // Legacy menu items have only `image`, so always expose a gallery with the
  // cover photo first. Duplicates are removed without changing the order.
  const images = [...new Set([item.image, ...(item.images ?? [])].filter(Boolean))];

  return {
    id: id(item),
    vendorId: item.vendorId,
    restaurantId: item.restaurantId?.toHexString() ?? null,
    restaurant,
    vendorName: enriched.vendorName ?? null,
    name: item.name,
    description: item.description,
    category: item.category,
    price: item.price,
    ingredients: item.ingredients,
    location: item.location || restaurant?.address || "",
    image: item.image,
    images,
    isActive: item.isActive,
    approvalStatus: item.approvalStatus,
    isFeatured: item.isFeatured,
    vendorPremium: item.vendorPremium ?? false,
    rejectionReason: item.rejectionReason ?? null,
    ratingAvg: enriched.ratingAvg ?? 0,
    reviewCount: enriched.reviewCount ?? 0,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
};

export const restaurantDto = (
  restaurant: RestaurantDoc,
  rating?: { ratingAvg: number; reviewCount: number },
) => ({
  id: id(restaurant),
  vendorId: restaurant.vendorId,
  name: restaurant.name,
  description: restaurant.description,
  image: restaurant.image,
  address: restaurant.address,
  phone: restaurant.phone,
  openingHours: restaurant.openingHours ?? null,
  ratingAvg: rating?.ratingAvg ?? 0,
  reviewCount: rating?.reviewCount ?? 0,
  createdAt: restaurant.createdAt,
  updatedAt: restaurant.updatedAt,
});

export const orderDto = (
  order: OrderDoc,
  restaurantName?: string | null,
) => ({
  id: id(order),
  orderNumber: order.orderNumber,
  customerId: order.customerId,
  vendorId: order.vendorId,
  menuItemId: order.menuItemId.toHexString(),
  quantity: order.quantity,
  unitPrice: order.unitPrice,
  totalPrice: order.totalPrice,
  deliveryAddress: order.deliveryAddress,
  deliveryDate: order.deliveryDate,
  message: order.message ?? null,
  status: order.status,
  timeline: order.timeline,
  customerSnapshot: order.customerSnapshot,
  menuItemSnapshot: order.menuItemSnapshot,
  // Live lookup first, then the name captured on the order for history.
  restaurantName:
    restaurantName ?? order.menuItemSnapshot.restaurantName ?? null,
  createdAt: order.createdAt,
  updatedAt: order.updatedAt,
});

export const favoriteDto = (favorite: FavoriteDoc) => ({
  id: id(favorite),
  customerId: favorite.customerId,
  menuItemId: favorite.menuItemId.toHexString(),
  createdAt: favorite.createdAt,
});

export const reviewDto = (review: ReviewDoc) => ({
  id: id(review),
  customerId: review.customerId,
  menuItemId: review.menuItemId?.toHexString() ?? null,
  restaurantId: review.restaurantId?.toHexString() ?? null,
  orderId: review.orderId.toHexString(),
  rating: review.rating,
  comment: review.comment,
  createdAt: review.createdAt,
  updatedAt: review.updatedAt,
});
