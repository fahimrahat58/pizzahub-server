import type { ObjectId } from "mongodb";

export type UserRole = "customer" | "vendor" | "admin";

/** Canonical plans. `pro` is accepted from legacy documents only. */
export type SubscriptionPlan = "free" | "premium";
export type LegacySubscriptionPlan = "pro";
export type StoredSubscriptionPlan = SubscriptionPlan | LegacySubscriptionPlan;

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
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  subscriptionExpiresAt?: Date | null;
  cancelAtPeriodEnd?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * One record per verified Stripe webhook event. Used for idempotency and for
 * the admin's read-only billing history view.
 */
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
  amount: number;
  currency: string;
  status: SubscriptionStatus;
  stripeEventId: string;
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

export interface ReviewDoc {
  _id: ObjectId;
  customerId: string;
  /** Present for pizza reviews; absent for restaurant-only reviews. */
  menuItemId?: ObjectId;
  /** Present for restaurant reviews; absent for pizza-only reviews. */
  restaurantId?: ObjectId;
  orderId: ObjectId;
  rating: number;
  comment: string;
  createdAt: Date;
  updatedAt: Date;
}
