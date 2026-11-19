import { ObjectId, type Filter } from "mongodb";

import { collections } from "../config/database.js";
import { forbidden } from "../utils/errors.js";
import { isValidObjectId } from "../utils/query.js";
import {
  ACTIVE_ORDER_STATUSES,
  TERMINAL_ORDER_STATUSES,
  type OrderDoc,
  type OrderStatus,
  type SubscriptionPlan,
  type UserRole,
} from "../types/models.js";
import {
  getEffectiveSubscription,
  SUBSCRIPTION_STATE_PROJECTION,
} from "./subscription.service.js";

export interface DashboardMetricPoint {
  label: string;
  value: number;
}

export interface DashboardSummary {
  role: UserRole;
  stats: {
    totalOrders: number;
    pendingOrders: number;
    completedOrders: number;
    favorites?: number;
    totalRestaurants?: number;
    activeMenuItems?: number;
    pendingMenuItems?: number;
    plan?: SubscriptionPlan;
    isPremium?: boolean;
    totalUsers?: number;
    totalVendors?: number;
    totalCustomers?: number;
    totalMenuItems?: number;
    totalTransactions?: number;
  };
  charts: {
    orderTrend: DashboardMetricPoint[];
    orderStatus: DashboardMetricPoint[];
    orderValueTrend?: DashboardMetricPoint[];
    userGrowth?: DashboardMetricPoint[];
  };
}

const ORDER_STATUSES: OrderStatus[] = [
  ...ACTIVE_ORDER_STATUSES,
  ...TERMINAL_ORDER_STATUSES,
];

const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  pending: "Pending",
  accepted: "Accepted",
  preparing: "Preparing",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  cancelled: "Cancelled",
  rejected: "Rejected",
};

const TREND_DAYS = 7;

/** UTC calendar days keep server and client trend buckets aligned. */
const recentDayKeys = (): string[] => {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return Array.from({ length: TREND_DAYS }, (_, index) => {
    const day = new Date(today);
    day.setUTCDate(today.getUTCDate() - (TREND_DAYS - 1 - index));
    return day.toISOString().slice(0, 10);
  });
};

const dayLabel = (key: string): string => {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
};

const toDayKey = (value: Date): string =>
  (value instanceof Date ? value : new Date(value)).toISOString().slice(0, 10);

type TrendOrders = Array<Pick<OrderDoc, "createdAt" | "totalPrice">>;

const buildTrends = (days: string[], orders: TrendOrders) => {
  const counts = new Map(days.map((day) => [day, 0]));
  const values = new Map(days.map((day) => [day, 0]));

  for (const order of orders) {
    const key = toDayKey(order.createdAt);
    if (!counts.has(key)) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    values.set(key, (values.get(key) ?? 0) + order.totalPrice);
  }

  return {
    orderTrend: days.map((day) => ({ label: dayLabel(day), value: counts.get(day) ?? 0 })),
    orderValueTrend: days.map((day) => ({
      label: dayLabel(day),
      value: Math.round((values.get(day) ?? 0) * 100) / 100,
    })),
  };
};

const orderStatusBreakdown = async (
  scope: Filter<OrderDoc>,
): Promise<DashboardMetricPoint[]> => {
  const rows = await collections
    .orders()
    .aggregate<{ _id: OrderStatus; count: number }>([
      { $match: scope },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ])
    .toArray();
  const counts = new Map(rows.map((row) => [row._id, row.count]));

  return ORDER_STATUSES.map((status) => ({
    label: ORDER_STATUS_LABELS[status],
    value: counts.get(status) ?? 0,
  }));
};

const countOrderStatuses = async (scope: Filter<OrderDoc>) => {
  const [totalOrders, pendingOrders, completedOrders] = await Promise.all([
    collections.orders().countDocuments(scope),
    collections.orders().countDocuments({ ...scope, status: "pending" }),
    collections.orders().countDocuments({ ...scope, status: "delivered" }),
  ]);
  return { totalOrders, pendingOrders, completedOrders };
};

const loadTrendOrders = async (
  scope: Filter<OrderDoc>,
  since: Date,
): Promise<TrendOrders> =>
  collections
    .orders()
    .find(
      { ...scope, createdAt: { $gte: since } },
      { projection: { createdAt: 1, totalPrice: 1 } },
    )
    .toArray();

const customerSummary = async (
  user: { id: string; role: UserRole },
  days: string[],
): Promise<DashboardSummary> => {
  const scope: Filter<OrderDoc> = { customerId: user.id };
  const [counts, favorites, statusBreakdown, orders] = await Promise.all([
    countOrderStatuses(scope),
    collections.favorites().countDocuments({ customerId: user.id }),
    orderStatusBreakdown(scope),
    loadTrendOrders(scope, new Date(`${days[0]}T00:00:00.000Z`)),
  ]);

  return {
    role: "customer",
    stats: { ...counts, favorites },
    charts: { ...buildTrends(days, orders), orderStatus: statusBreakdown },
  };
};

const vendorSummary = async (
  user: { id: string; role: UserRole },
  days: string[],
): Promise<DashboardSummary> => {
  const scope: Filter<OrderDoc> = { vendorId: user.id };
  const [vendor, totalRestaurants, activeMenuItems, counts, statusBreakdown, orders] =
    await Promise.all([
      isValidObjectId(user.id)
        ? collections
            .users()
            .findOne(
              { _id: new ObjectId(user.id) },
              { projection: SUBSCRIPTION_STATE_PROJECTION },
            )
        : Promise.resolve(null),
      collections.restaurants().countDocuments({ vendorId: user.id }),
      collections.menuItems().countDocuments({
        vendorId: user.id,
        isActive: true,
        approvalStatus: "approved",
      }),
      countOrderStatuses(scope),
      orderStatusBreakdown(scope),
      loadTrendOrders(scope, new Date(`${days[0]}T00:00:00.000Z`)),
    ]);
  const subscription = getEffectiveSubscription(vendor ?? {});

  return {
    role: "vendor",
    stats: {
      ...counts,
      totalRestaurants,
      activeMenuItems,
      plan: subscription.plan,
      isPremium: subscription.isPremium,
    },
    charts: { ...buildTrends(days, orders), orderStatus: statusBreakdown },
  };
};

const adminSummary = async (
  days: string[],
): Promise<DashboardSummary> => {
  const since = new Date(`${days[0]}T00:00:00.000Z`);
  const [
    totalUsers,
    totalVendors,
    totalCustomers,
    totalRestaurants,
    totalMenuItems,
    pendingMenuItems,
    totalTransactions,
    counts,
    statusBreakdown,
    orders,
    growthRows,
  ] = await Promise.all([
    collections.users().countDocuments({}),
    collections.users().countDocuments({ role: "vendor" }),
    collections.users().countDocuments({ role: "customer" }),
    collections.restaurants().countDocuments({}),
    collections.menuItems().countDocuments({}),
    collections.menuItems().countDocuments({ approvalStatus: "pending" }),
    collections.transactions().countDocuments({}),
    countOrderStatuses({}),
    orderStatusBreakdown({}),
    loadTrendOrders({}, since),
    collections
      .users()
      .aggregate<{ _id: string; count: number }>([
        { $match: { createdAt: { $gte: since } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "UTC" } },
            count: { $sum: 1 },
          },
        },
      ])
      .toArray(),
  ]);
  const growth = new Map(growthRows.map((row) => [row._id, row.count]));

  return {
    role: "admin",
    stats: {
      ...counts,
      totalUsers,
      totalVendors,
      totalCustomers,
      totalRestaurants,
      totalMenuItems,
      pendingMenuItems,
      totalTransactions,
    },
    charts: {
      ...buildTrends(days, orders),
      orderStatus: statusBreakdown,
      userGrowth: days.map((day) => ({ label: dayLabel(day), value: growth.get(day) ?? 0 })),
    },
  };
};

/** Builds role-appropriate dashboard aggregates from trusted server data only. */
export const buildDashboardSummary = async (user: {
  id: string;
  role: UserRole;
}): Promise<DashboardSummary> => {
  const days = recentDayKeys();
  if (user.role === "customer") return customerSummary(user, days);
  if (user.role === "vendor") return vendorSummary(user, days);
  if (user.role === "admin") return adminSummary(days);
  throw forbidden("Invalid user role");
};
