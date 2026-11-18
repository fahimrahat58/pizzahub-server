import "dotenv/config";

import { pathToFileURL } from "node:url";

import app from "./app.js";
import { initializeRuntime } from "./config/bootstrap.js";
import { env } from "./config/env.js";

/**
 * Vercel's Express detection expects `src/index.ts` to default-export the
 * Express application itself. Do not start a listener in this module when it
 * is imported by the serverless runtime.
 */
export default app;

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

const isVercel = Boolean(
  process.env.VERCEL ?? process.env.VERCEL_ENV ?? process.env.VERCEL_REGION,
);

/** Local `npm run dev` / `npm start` still starts a normal HTTP server. */
if (isDirectRun && !isVercel) {
  void initializeRuntime()
    .then(() => {
      app.listen(env.port, () => {
        console.log(`PizzaHub server running on port ${env.port}`);
      });
    })
    .catch((error: unknown) => {
      console.error("Server startup failed:", error);
      process.exit(1);
    });
}
