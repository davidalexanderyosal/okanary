import { Hono } from "hono";
import type { AppEnv } from "./env";
import { meta } from "./routes/meta";
import { transactions } from "./routes/transactions";

export function createApp() {
  const app = new Hono<AppEnv>();
  // Cloudflare Access protects the app and /api/* (spec §5); no login is built here.
  app.route("/api", meta);
  app.route("/api/transactions", transactions);
  // /api/ingest/* intentionally not implemented in Phase 0/1.
  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));
  app.onError((err, c) => {
    console.error("unhandled", err.message); // never log bodies/tokens
    return c.json({ error: "internal" }, 500);
  });
  return app;
}
