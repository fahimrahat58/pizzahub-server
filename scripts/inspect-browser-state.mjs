import "dotenv/config";
import { MongoClient } from "mongodb";

const client = new MongoClient(process.env.MONGODB_URI, {
  serverSelectionTimeoutMS: 10_000,
});
await client.connect();
const db = client.db(process.env.DB_NAME);

const vendor = await db.collection("users").findOne({ email: "browser-v-mwl0flvr@example.com" });
if (!vendor) {
  console.log("vendor not found");
} else {
  const restaurants = await db.collection("restaurants").find({ vendorId: vendor._id.toHexString() }).toArray();
  const items = await db.collection("menuItems").find({ vendorId: vendor._id.toHexString() }).toArray();
  const orders = await db.collection("orders").find({ vendorId: vendor._id.toHexString() }).toArray();
  console.log(JSON.stringify({
    vendorId: vendor._id.toHexString(),
    plan: vendor.subscriptionPlan,
    phone: vendor.phone ?? null,
    address: vendor.address ?? null,
    image: vendor.image ? "set" : null,
    restaurants: restaurants.map(r => ({ id: r._id.toHexString(), name: r.name })),
    items: items.map(i => ({ id: i._id.toHexString(), name: i.name, active: i.isActive, approval: i.approvalStatus, restaurantId: i.restaurantId?.toHexString() ?? null })),
    orders: orders.map(o => ({ id: o._id.toHexString(), status: o.status })),
  }, null, 2));
}
await client.close();
