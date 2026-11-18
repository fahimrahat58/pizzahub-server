import "dotenv/config";

import type { IncomingMessage, ServerResponse } from "node:http";

import app from "./app.js";
import { connectDB } from "./config/database.js";
import { createIndexes } from "./config/indexes.js";
import { migrateMenuPublishing } from "./config/migrations.js";
import { env } from "./config/env.js";

/**
 * Serverless functions reuse the same module instance, so initialization is
 * cached. A failed attempt is cleared so the next invocation can retry.
 */
let initialization: Promise<void> | undefined;

const initialize = (): Promise<void> => {
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

const handleRequest = (
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      res.off("finish", onFinish);
      res.off("close", onClose);
      res.off("error", onError);
    };

    const onFinish = (): void => {
      cleanup();
      resolve();
    };

    const onClose = (): void => {
      cleanup();
      resolve();
    };

    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    res.once("finish", onFinish);
    res.once("close", onClose);
    res.once("error", onError);

    try {
      app(req, res);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });

/** Vercel invokes this exported function instead of starting an HTTP listener. */
export const handler = async (
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> => {
  await initialize();
  await handleRequest(req, res);
};

export default handler;

/** Local development still uses `app.listen()`. */
const startServer = async (): Promise<void> => {
  try {
    await initialize();
    app.listen(env.port, () => {
      console.log(`PizzaHub server running on port ${env.port}`);
    });
  } catch (error) {
    console.error("Server startup failed:", error);
    process.exit(1);
  }
};

if (process.env.VERCEL !== "1") {
  void startServer();
}
