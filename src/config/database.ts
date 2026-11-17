import "dotenv/config";
import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;
const dbName = process.env.DB_NAME;

if (!uri) {
  throw new Error("MONGODB_URI is missing");
}

if (!dbName) {
  throw new Error("DB_NAME is missing");
}

export const mongoClient = new MongoClient(uri);
export const db = mongoClient.db(dbName);

export const connectDB = async () => {
  await mongoClient.connect();
  console.log("MongoDB connected successfully");
};
