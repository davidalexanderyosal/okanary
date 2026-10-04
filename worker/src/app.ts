import { Hono } from "hono";
import type { Deps } from "./deps";
import type { AppEnv } from "./env";
import { accuracy } from "./routes/accuracy";
import { allowance } from "./routes/allowance";
import { budgets } from "./routes/budgets";
import { goals } from "./routes/goals";
import { ingest } from "./routes/ingest";
import { insights } from "./routes/insights";
import { meta } from "./routes/meta";
import { networth } from "./routes/networth";
import { review } from "./routes/review";
import { setup } from "./routes/setup";
import { subscriptions } from "./routes/subscriptions";
import { transactions } from "./routes/transactions";
import { usual } from "./routes/usual";
import { wants } from "./routes/wants";

export function createApp(overrides: Partial<Deps> = {}) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("deps", { now: () => new Date(), fetch: (...a) => fetch(...a), ai: c.env.AI, ...overrides });
    await next();
  });
  // Cloudflare Access protects the app and /api/* (spec §5); no login is built here.
  // /api/ingest/applepay is the one path excluded from Access and guarded by the bearer token instead.
  app.route("/api/ingest", ingest);
  app.route("/api", meta);
  app.route("/api", review);
  app.route("/api", budgets);
  app.route("/api", accuracy);
  app.route("/api", insights);
  app.route("/api", allowance);
  app.route("/api", usual);
  app.route("/api", networth);
  app.route("/api", goals);
  app.route("/api", setup);
  app.route("/api", wants);
  app.route("/api", subscriptions);
  app.route("/api/transactions", transactions);
  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));
  app.onError((err, c) => {
    console.error("unhandled", err.message); // never log bodies/tokens
    return c.json({ error: "internal" }, 500);
  });
  return app;
}
