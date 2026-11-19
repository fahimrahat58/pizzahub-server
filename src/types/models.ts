import type { ObjectId } from "mongodb";

export type UserRole = "customer" | "vendor" | "admin";

/** Canonical plans. `pro` is accepted from legacy documents only. */
export type SubscriptionPlan = "free" | "premium";
export type LegacySubscriptionPlan = "pro";
export type StoredSubscriptionPlan = SubscriptionPlan | LegacySubscriptionPlan;

/** Billing plans accepted by PizzaHub's checkout API. */
export type BillingPlanId = "monthly" | "yearly";

/** Actual recurring interval read from the Stripe Price on a subscription. */
export type BillingInterval = "month" | "year";

/** Mirrors Stripe's subscription statuses that PizzaHub cares about. */
export type SubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "unpaid"
  | "incomplete"
  | "incomplete_expired"
  | "canceled"
  | "paused";

/** Better Auth owns the `users` collection and stores ObjectId values in `_id`. */
export interface UserDoc {
  _id: ObjectId;
  name: string;
  email: string;
  image?: string | null;
  role: UserRole;
  isBlocked?: boolean;
  businessName?: string | null;
  /** Optional vendor contact details, editable from the vendor profile page. */
  phone?: string | null;
  address?: string | null;
  subscriptionPlan?: StoredSubscriptionPlan;
  subscriptionStatus?: SubscriptionStatus | null;
  /** Legacy plan id, derived from the verified Stripe Price when available. */
  billingPlanId?: BillingPlanId | null;
  /** Actual interval from the Price attached to the verified subscription. */
  billingInterval?: BillingInterval | null;
  /** Stripe Price ID from the verified subscription snapshot. */
  stripePriceId?: string | null;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  stripeCheckoutSessionId?: string | null;
  /** Event timestamp of the last accepted checkout/session linkage. */
  checkoutEventCreatedAt?: Date | null;
  /** Period boundaries from the verified Stripe subscription snapshot. */
  currentPeriodStart?: Date | null;
  currentPeriodEnd?: Date | null;
  subscriptionExpiresAt?: Date | null;
  /** Stripe's cancel_at: when a scheduled cancellation takes effect. */
  cancelAt?: Date | null;
  cancelAtPeriodEnd?: boolean;
  /** Time Stripe reported that the subscription actually ended. */
  endedAt?: Date | null;
  /** Time Stripe reported that the subscription was actually canceled. */
  canceledAt?: Date | null;
  /** Event timestamp/ID of the last accepted subscription state change. */
  subscriptionEventCreatedAt?: Date | null;
  subscriptionEventId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * One record per verified Stripe webhook event. Used for idempotency and for
 * the admin's read-only billing history view.
 */
/** Short-lived, atomic guard preventing concurrent checkout sessions per vendor. */
export interface CheckoutLockDoc {
  /** Vendor user id as a string. */
  _id: string;
  vendorId: string;
  plan: BillingPlanId;
  sessionId?: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface StripeEventDoc {
  _id: string;
  type: string;
  vendorId?: string | null;
  status: "processing" | "processed" | "failed";
  createdAt: Date;
  processedAt?: Date | null;
  error?: string | null;
}

export interface SubscriptionEventDoc {
  _id: ObjectId;
  vendorId: string;
  stripeEventId: string;
  type: string;
  plan?: SubscriptionPlan | null;
  billingInterval?: BillingInterval | null;
  status?: SubscriptionStatus | null;
  description?: string | null;
  createdAt: Date;
}

export type ApprovalStatus = "pending" | "approved" | "rejected";

/** Read-only billing record created from verified Stripe webhooks. */
export interface TransactionDoc {
  _id: ObjectId;
  vendorId: string;
  vendorName: string;
  vendorEmail: string;
  plan: SubscriptionPlan;
  billingInterval?: BillingInterval | null;
  amount: number;
  currency: string;
  status: SubscriptionStatus;
  stripeEventId: string;
  stripeInvoiceId?: string | null;
  stripeSubscriptionId?: string | null;
  description?: string | null;
  createdAt: Date;
}

export interface MenuItemDoc {
  _id: ObjectId;
  vendorId: string;
  restaurantId?: ObjectId | null;
  name: string;
  description: string;
  category: string;
  price: number;
  ingredients: string[];
  /** Area / city where this item is offered. */
  location: string;
  /** Cover photo. Legacy documents always have this field. */
  image: string;
  /** Full gallery; the first entry is the cover photo. */
  images?: string[];
  isActive: boolean;
  approvalStatus: ApprovalStatus;
  isFeatured: boolean;
  vendorPremium?: boolean;
  rejectionReason?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RestaurantDoc {
  _id: ObjectId;
  vendorId: string;
  name: string;
  description: string;
  image: string;
  address: string;
  phone: string;
  openingHours?: string | null;
  /** Internal, unique-per-vendor slot used to cap Free plan restaurants. */
  freeSlot?: number;
  createdAt: Date;
  updatedAt: Date;
}

export type OrderStatus =
  | "pending"
  | "accepted"
  | "preparing"
  | "out_for_delivery"
  | "delivered"
  | "cancelled"
  | "rejected";

export const ACTIVE_ORDER_STATUSES: OrderStatus[] = [
  "pending",
  "accepted",
  "preparing",
  "out_for_delivery",
];

export const TERMINAL_ORDER_STATUSES: OrderStatus[] = [
  "delivered",
  "cancelled",
  "rejected",
];

export interface TimelineEntry {
  status: OrderStatus;
  note?: string;
  at: Date;
  by: "customer" | "vendor" | "system";
}

export interface OrderDoc {
  _id: ObjectId;
  orderNumber: string;
  customerId: string;
  vendorId: string;
  menuItemId: ObjectId;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  deliveryAddress: string;
  deliveryDate: string;
  message?: string | null;
  status: OrderStatus;
  timeline: TimelineEntry[];
  /** Present only while the order is active. Enforces one active order per item/date. */
  activeOrderKey?: string;
  customerSnapshot: {
    name: string;
    email: string;
    image?: string | null;
  };
  menuItemSnapshot: {
    name: string;
    image: string;
    price: number;
    /** Captured at order time so historical orders keep a restaurant label. */
    restaurantName?: string | null;
  };
  createdAt: Date;
  updatedAt: Date;
}

export interface FavoriteDoc {
  _id: ObjectId;
  customerId: string;
  menuItemId: ObjectId;
  createdAt: Date;
}

export type RatingDistribution = Record<"1" | "2" | "3" | "4" | "5", number>;

export interface ReviewDoc {
  _id: ObjectId;
  customerId: string;
  /** Snapshot of the customer name so historical reviews keep an author. */
  customerName?: string;
  /** Present for pizza reviews; absent for restaurant-only reviews. */
  menuItemId?: ObjectId;
  /** Present for restaurant reviews; absent for pizza-only reviews. */
  restaurantId?: ObjectId;
  orderId: ObjectId;
  rating: number;
  comment: string;
  /** Admin moderation flag. Hidden reviews are excluded from public ratings. */
  isHidden?: boolean;
  createdAt: Date;
  updatedAt: Date;
}
