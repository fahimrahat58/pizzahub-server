import type {
  FavoriteDoc,
  MenuItemDoc,
  OrderDoc,
  OrderStatus,
  RatingDistribution,
  RestaurantDoc,
  ReviewDoc,
  TransactionDoc,
  UserDoc,
} from "../types/models.js";
import { getEffectiveSubscription } from "../services/subscription.service.js";

const id = (value: { _id: { toHexString: () => string } }): string =>
  value._id.toHexString();

/**
 * A vendor needs to recognise a customer, not receive an extra copy of their
 * email address. Keep enough of the address to be useful while masking the
 * locally identifiable part.
 */
const customerReference = (transaction: TransactionDoc): string | null => {
  if (transaction.customerEmail) {
    const at = transaction.customerEmail.lastIndexOf("@");
    if (at > 0) {
      const local = transaction.customerEmail.slice(0, at);
      const domain = transaction.customerEmail.slice(at + 1);
      return `${local.slice(0, 1)}***@${domain}`;
    }
  }
  if (transaction.customerId) return `customer ${transaction.customerId.slice(0, 8)}`;
  return null;
};

export type TransactionEnrichment = {
  orderNumber?: string | null;
  orderCreatedAt?: Date | string | null;
  orderStatus?: OrderStatus | null;
};

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
    billingPlanId: user.billingPlanId ?? null,
    billingInterval: user.billingInterval ?? null,
    stripeCustomerId: user.stripeCustomerId ?? null,
    stripeSubscriptionId: user.stripeSubscriptionId ?? null,
    stripeCheckoutSessionId: user.stripeCheckoutSessionId ?? null,
    stripePriceId: user.stripePriceId ?? null,
    currentPeriodStart: user.currentPeriodStart ?? null,
    currentPeriodEnd: user.currentPeriodEnd ?? null,
    subscriptionExpiresAt: effective.expiresAt,
    cancelAt: user.cancelAt ?? null,
    cancelAtPeriodEnd: effective.cancelAtPeriodEnd,
    endedAt: user.endedAt ?? null,
    canceledAt: effective.canceledAt,
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
  isAvailable?: boolean | null;
};

type MenuEnrichment = {
  ratingAvg?: number;
  reviewCount?: number;
  ratingDistribution?: RatingDistribution;
  restaurantInfo?: RestaurantSummarySource[];
  restaurant?: RestaurantSummarySource | null;
  vendorName?: string | null;
  vendorPremium?: boolean | null;
};

const emptyRatingDistribution = (): RatingDistribution => ({
  "1": 0,
  "2": 0,
  "3": 0,
  "4": 0,
  "5": 0,
});

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
    isAvailable: source.isAvailable !== false,
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
    vendorPremium: enriched.vendorPremium ?? item.vendorPremium ?? false,
    rejectionReason: item.rejectionReason ?? null,
    ratingAvg: enriched.ratingAvg ?? 0,
    reviewCount: enriched.reviewCount ?? 0,
    ratingDistribution: enriched.ratingDistribution ?? emptyRatingDistribution(),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
};

export const restaurantDto = (
  restaurant: RestaurantDoc,
  rating?: { ratingAvg: number; reviewCount: number },
  vendorPremium = false,
) => ({
  id: id(restaurant),
  vendorId: restaurant.vendorId,
  vendorPremium,
  name: restaurant.name,
  description: restaurant.description,
  image: restaurant.image,
  address: restaurant.address,
  phone: restaurant.phone,
  openingHours: restaurant.openingHours ?? null,
  isAvailable: restaurant.isAvailable !== false,
  ratingAvg: rating?.ratingAvg ?? 0,
  reviewCount: rating?.reviewCount ?? 0,
  createdAt: restaurant.createdAt,
  updatedAt: restaurant.updatedAt,
});

/** One DTO for the centralized transaction ledger, whichever payment type it is. */
export const transactionDto = (
  transaction: TransactionDoc,
  enrichment: TransactionEnrichment = {},
) => ({
  id: transaction._id.toHexString(),
  paymentType: transaction.paymentType ?? "vendor_subscription",
  vendorId: transaction.vendorId,
  vendorName: transaction.vendorName,
  vendorEmail: transaction.vendorEmail,
  customerId: transaction.customerId ?? null,
  customerName: transaction.customerName ?? null,
  customerEmail: transaction.customerEmail ?? null,
  customerReference: customerReference(transaction),
  restaurantId: transaction.restaurantId ?? null,
  restaurantName: transaction.restaurantName ?? null,
  orderId: transaction.orderId ?? null,
  orderNumber: enrichment.orderNumber ?? null,
  orderCreatedAt: enrichment.orderCreatedAt ?? null,
  orderStatus: enrichment.orderStatus ?? null,
  plan: transaction.plan ?? null,
  billingInterval: transaction.billingInterval ?? null,
  amount: transaction.amount,
  currency: transaction.currency,
  status: transaction.status,
  paymentStatus: transaction.paymentStatus ?? null,
  paymentMethod: transaction.paymentMethod ?? null,
  stripeEventId: transaction.stripeEventId,
  stripeInvoiceId: transaction.stripeInvoiceId ?? null,
  stripeSessionId: transaction.stripeSessionId ?? null,
  stripePaymentIntentId: transaction.stripePaymentIntentId ?? null,
  stripeSubscriptionId: transaction.stripeSubscriptionId ?? null,
  description: transaction.description ?? null,
  refundedAmount: transaction.refundedAmount ?? 0,
  refunds: transaction.refunds ?? [],
  createdAt: transaction.createdAt,
  updatedAt: transaction.updatedAt ?? transaction.createdAt,
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
  // Only checkout orders carry these keys; legacy Stripe-free orders remain
  // byte-for-byte compatible with existing API consumers.
  ...(order.restaurantId ? { restaurantId: order.restaurantId.toHexString() } : {}),
  ...(order.items ? { items: order.items } : {}),
  ...(order.subtotal !== undefined ? { subtotal: order.subtotal } : {}),
  ...(order.deliveryFee !== undefined ? { deliveryFee: order.deliveryFee } : {}),
  ...(order.totalAmount !== undefined ? { totalAmount: order.totalAmount } : {}),
  ...(order.currency ? { currency: order.currency } : {}),
  ...(order.paymentMethod ? { paymentMethod: order.paymentMethod } : {}),
  ...(order.paymentStatus ? { paymentStatus: order.paymentStatus } : {}),
  ...(order.stripeSessionId ? { stripeSessionId: order.stripeSessionId } : {}),
  ...(order.stripePaymentIntentId
    ? { stripePaymentIntentId: order.stripePaymentIntentId }
    : {}),
  createdAt: order.createdAt,
  updatedAt: order.updatedAt,
});

export const favoriteDto = (favorite: FavoriteDoc) => ({
  id: id(favorite),
  customerId: favorite.customerId,
  menuItemId: favorite.menuItemId.toHexString(),
  createdAt: favorite.createdAt,
});

type ReviewDtoOptions = {
  /** Only privileged/private views should expose the internal customer id. */
  includeCustomerId?: boolean;
  /** Admin/vendor views can surface the moderation state. */
  includeHidden?: boolean;
  customerEmail?: string | null;
  productName?: string | null;
  restaurantName?: string | null;
};

export const reviewDto = (
  review: ReviewDoc,
  options: ReviewDtoOptions = {},
) => ({
  id: id(review),
  ...(options.includeCustomerId ? { customerId: review.customerId } : {}),
  customerName: review.customerName ?? null,
  menuItemId: review.menuItemId?.toHexString() ?? null,
  restaurantId: review.restaurantId?.toHexString() ?? null,
  orderId: review.orderId.toHexString(),
  rating: review.rating,
  comment: review.comment,
  ...(options.includeHidden ? { isHidden: review.isHidden ?? false } : {}),
  ...(options.customerEmail !== undefined
    ? { customerEmail: options.customerEmail }
    : {}),
  ...(options.productName !== undefined ? { productName: options.productName } : {}),
  ...(options.restaurantName !== undefined
    ? { restaurantName: options.restaurantName }
    : {}),
  createdAt: review.createdAt,
  updatedAt: review.updatedAt,
});
