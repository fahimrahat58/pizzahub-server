import { connectDB } from "./database.js";
import { createIndexes } from "./indexes.js";
import { migrateMenuPublishing } from "./migrations.js";

/**
 * Serverless invocations reuse the same module instance. Cache initialization
 * so MongoDB, indexes, and migrations run once per instance, not per request.
 */
let initialization: Promise<void> | undefined;

export const initializeRuntime = (): Promise<void> => {
  if (!initialization) {
    initialization = (async () => {
      await connectDB();
      await createIndexes();
      await migrateMenuPublishing();
    })().catch((error: unknown) => {
      initialization = undefined;
      throw error;
    });
  }
  return initialization;
};
