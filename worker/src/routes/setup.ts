import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { pushConfigured, sendPushToAll } from "../push";
import { effectiveIngestToken } from "./ingest";
import { getSetting, setSetting } from "../settings";
import { nowIso, ulid } from "../util";

export const setup = new Hono<AppEnv>();

const randomToken = () => {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** Everything the Setup page needs. Served behind Cloudflare Access only (the token is shown to its owner). */
setup.get("/setup", async (c) => {
  const [token, post] = await Promise.all([effectiveIngestToken(c.env.DB, c.env.INGEST_TOKEN), getSetting(c.env.DB, "push_post_purchase")]);
  const subs = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").first<{ n: number }>();
  const last = await c.env.DB.prepare("SELECT received_at FROM raw_ingest WHERE source = 'applepay' ORDER BY received_at DESC LIMIT 1").first<{ received_at: string }>();
  return c.json({
    ingest_path: "/api/ingest/applepay",
    token,
    last_applepay_at: last?.received_at ?? null,
    push: { configured: pushConfigured(c.env), public_key: c.env.VAPID_PUBLIC_KEY ?? null, subscriptions: subs?.n ?? 0, post_purchase: post !== "0" },
  });
});

/** Rotate (or first-generate) the ingest token. The old token stops working immediately. */
setup.post("/setup/token", async (c) => {
  const token = randomToken();
  await setSetting(c.env.DB, "ingest_token", token);
  return c.json({ token });
});

setup.put("/settings", async (c) => {
  const p = z.object({ push_post_purchase: z.boolean().optional() }).safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ error: p.error.flatten() }, 400);
  if (p.data.push_post_purchase !== undefined) await setSetting(c.env.DB, "push_post_purchase", p.data.push_post_purchase ? "1" : "0");
  return c.json({ ok: true });
});

const subSchema = z.object({ endpoint: z.string().url().startsWith("https://"), keys: z.object({ p256dh: z.string().min(10), auth: z.string().min(10) }) });
setup.post("/push/subscribe", async (c) => {
  const p = subSchema.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ error: p.error.flatten() }, 400);
  await c.env.DB.prepare("INSERT INTO push_subscriptions (id, endpoint, keys, created_at) VALUES (?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET keys = excluded.keys")
    .bind(ulid(), p.data.endpoint, JSON.stringify(p.data.keys), nowIso()).run();
  return c.json({ ok: true }, 201);
});
setup.post("/push/unsubscribe", async (c) => {
  const p = z.object({ endpoint: z.string() }).safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ error: "bad request" }, 400);
  await c.env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(p.data.endpoint).run();
  return c.json({ ok: true });
});
setup.post("/push/test", async (c) => {
  const n = await sendPushToAll(c.env, c.var.deps, { title: "Okanary", body: "Test notification: push is working.", url: "/", tag: "test" });
  return c.json({ delivered: n, configured: pushConfigured(c.env) });
});
