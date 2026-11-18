import { collections } from "./database.js";

const RESTAURANT_VENDOR_INDEX = "restaurants_vendor_idx";

/**
 * Earlier releases allowed only one restaurant per vendor and created a unique
 * `vendorId` index. Replace it with a non-unique index so multi-restaurant
 * vendors can be persisted without an index-options conflict at startup.
 */
const ensureRestaurantVendorIndex = async (): Promise<void> => {
  const restaurants = collections.restaurants();
  const existing = await restaurants.indexes();
  const conflicting = existing.filter((index) => {
    if (!index.name) return false;
    const keys = Object.keys(index.key ?? {});
    return (
      keys.length === 1 &&
      keys[0] === "vendorId" &&
      (index.name !== RESTAURANT_VENDOR_INDEX || index.unique === true)
    );
  });

  for (const index of conflicting) {
    await restaurants.dropIndex(index.name!);
  }
  await restaurants.createIndex(
    { vendorId: 1 },
    { name: RESTAURANT_VENDOR_INDEX },
  );
};

/**
 * Creates the indexes used by the application. Index creation is idempotent,
 * and failures for a single index are logged without preventing startup.
 */
export const createIndexes = async (): Promise<void> => {
  const jobs: Array<{ name: string; run: () => Promise<unknown> }> = [
    {
      name: "users.email",
      // Better Auth creates this index with a custom name; reuse it so startup
      // does not fail with an index-options conflict.
      run: () =>
        collections
          .users()
          .createIndex({ email: 1 }, { unique: true, name: "users_email_uidx" }),
    },
    {
      name: "users.role",
      run: () => collections.users().createIndex({ role: 1 }),
    },
    {
      name: "menuItems.public",
      run: () =>
        collections
          .menuItems()
          .createIndex({ approvalStatus: 1, isActive: 1, isFeatured: -1 }),
    },
    {
      name: "menuItems.vendor",
      run: () => collections.menuItems().createIndex({ vendorId: 1 }),
    },
    {
      name: "menuItems.restaurant",
      run: () => collections.menuItems().createIndex({ restaurantId: 1 }),
    },
    {
      name: "menuItems.filters",
      run: () =>
        collections.menuItems().createIndex({ category: 1, price: 1 }),
    },
    {
      name: "menuItems.search",
      run: () =>
        collections.menuItems().createIndex({
          name: "text",
          description: "text",
          ingredients: "text",
        }),
    },
    {
      name: "restaurants.vendor",
      run: ensureRestaurantVendorIndex,
    },
    {
      name: "orders.customer",
      run: () =>
        collections.orders().createIndex({ customerId: 1, createdAt: -1 }),
    },
    {
      name: "orders.vendor",
      run: () =>
        collections.orders().createIndex({ vendorId: 1, status: 1, createdAt: -1 }),
    },
    {
      name: "orders.activeKey",
      run: () =>
        collections.orders().createIndex(
          { activeOrderKey: 1 },
          {
            unique: true,
            partialFilterExpression: { activeOrderKey: { $type: "string" } },
            name: "orders_one_active_per_item_date",
          },
        ),
    },
    {
      name: "favorites.unique",
      run: () =>
        collections
          .favorites()
          .createIndex({ customerId: 1, menuItemId: 1 }, { unique: true }),
    },
    {
      name: "reviews.unique",
      run: () =>
        collections
          .reviews()
          .createIndex({ orderId: 1, menuItemId: 1 }, { unique: true }),
    },
    {
      name: "reviews.menuItem",
      run: () => collections.reviews().createIndex({ menuItemId: 1, rating: -1 }),
    },
    {
      name: "reviews.unique.restaurant",
      run: () =>
        collections
          .reviews()
          .createIndex(
            { orderId: 1, restaurantId: 1 },
            {
              unique: true,
              partialFilterExpression: { restaurantId: { $type: "objectId" } },
              name: "reviews_one_per_order_restaurant",
            },
          ),
    },
    {
      name: "reviews.restaurant",
      run: () => collections.reviews().createIndex({ restaurantId: 1, rating: -1 }),
    },
    {
      name: "users.stripeCustomer",
      run: () =>
        collections.users().createIndex(
          { stripeCustomerId: 1 },
          {
            name: "users_stripe_customer_uidx",
            unique: true,
            partialFilterExpression: { stripeCustomerId: { $type: "string" } },
          },
        ),
    },
    {
      name: "users.stripeSubscription",
      run: () =>
        collections.users().createIndex(
          { stripeSubscriptionId: 1 },
          {
            name: "users_stripe_subscription_uidx",
            unique: true,
            partialFilterExpression: { stripeSubscriptionId: { $type: "string" } },
          },
        ),
    },
    {
      name: "subscriptionEvents.vendor",
      run: () =>
        collections
          .subscriptionEvents()
          .createIndex({ vendorId: 1, createdAt: -1 }),
    },
    {
      name: "subscriptionEvents.stripeEvent",
      run: () =>
        collections
          .subscriptionEvents()
          .createIndex({ stripeEventId: 1 }, { unique: true }),
    },
    {
      name: "transactions.vendor",
      run: () =>
        collections
          .transactions()
          .createIndex({ vendorId: 1, createdAt: -1 }),
    },
    {
      name: "transactions.stripeEvent",
      run: () =>
        collections
          .transactions()
          .createIndex({ stripeEventId: 1 }, { unique: true }),
    },
  ];

  await Promise.allSettled(
    jobs.map(async (job) => {
      try {
        await job.run();
      } catch (error) {
        console.warn(`Index "${job.name}" was not created:`, error);
      }
    }),
  );
};
