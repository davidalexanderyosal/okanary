import { Hono } from "hono";
import { z } from "zod";
import { parseNudgeLimit, parseQuietHours, parseThresholds } from "@okanary/core";
import { loadAllowanceSettings } from "../allowance";
import type { AppEnv } from "../env";
import { pushConfigured, sendPushToAll } from "../push";
import { effectiveIngestToken } from "./ingest";
import { deleteSetting, getSetting, setSetting } from "../settings";
import { nowIso, ulid } from "../util";
import { loadLongWaitThreshold } from "../wants";

export const setup = new Hono<AppEnv>();

const randomToken = () => {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const hm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/** Everything the Setup page needs. Served behind Cloudflare Access only (the token is shown to its owner). */
setup.get("/setup", async (c) => {
  const [token, post] = await Promise.all([effectiveIngestToken(c.env.DB, c.env.INGEST_TOKEN), getSetting(c.env.DB, "push_post_purchase")]);
  const subs = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").first<{ n: number }>();
  const last = await c.env.DB.prepare("SELECT received_at FROM raw_ingest WHERE source = 'applepay' ORDER BY received_at DESC LIMIT 1").first<{ received_at: string }>();
  const mail = (await c.env.DB.prepare("SELECT source, MAX(received_at) AS t, SUM(parse_status = 'failed') AS failed FROM raw_ingest WHERE source LIKE 'email:%' GROUP BY source").all<{ source: string; t: string; failed: number }>()).results;
  const emailStatus = Object.fromEntries(mail.map((m) => [m.source.slice(6), { last_at: m.t, failed: m.failed }]));
  const allowance = await loadAllowanceSettings(c.env.DB);
  const [nl, qs, qe] = await Promise.all([getSetting(c.env.DB, "nudge_daily_limit"), getSetting(c.env.DB, "quiet_start"), getSetting(c.env.DB, "quiet_end")]);
  const quiet = parseQuietHours(qs, qe);
  return c.json({
    allowance_settings: { week_start: allowance.weekStart, override_minor: allowance.overrideMinor, carry: allowance.carryEnabled },
    notifications: { daily_limit: parseNudgeLimit(nl), quiet_start: hm(quiet.start), quiet_end: hm(quiet.end) },
    email: { forward_configured: !!c.env.FORWARD_TO, banks: emailStatus },
    alerts: { thresholds: parseThresholds(await getSetting(c.env.DB, "alert_thresholds")) },
    wants: { long_wait_threshold_minor: await loadLongWaitThreshold(c.env.DB) },
    ingest_path: "/api/ingest/applepay",
    token,
    last_applepay_at: last?.received_at ?? null,
    push: { configured: pushConfigured(c.env), public_key: c.env.VAPID_PUBLIC_KEY ?? null, subscriptions: subs?.n ?? 0, post_purchase: post !== "0", weekly_digest: (await getSetting(c.env.DB, "push_weekly_digest")) !== "0" },
  });
});

/** Rotate (or first-generate) the ingest token. The old token stops working immediately. */
setup.post("/setup/token", async (c) => {
  const token = randomToken();
  await setSetting(c.env.DB, "ingest_token", token);
  return c.json({ token });
});

const hmSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const settingsSchema = z.object({
  push_post_purchase: z.boolean().optional(),
  push_weekly_digest: z.boolean().optional(),
  alert_thresholds: z.array(z.number().int().min(1).max(200)).max(6).optional(),
  // v2 A: weekly allowance + notification limits
  week_start: z.number().int().min(0).max(6).optional(),
  /** weekly amount in SGD minor units; 0 or null removes the override */
  allowance_override_minor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  allowance_carry: z.boolean().optional(),
  nudge_daily_limit: z.number().int().min(0).max(20).optional(),
  quiet_start: hmSchema.optional(),
  quiet_end: hmSchema.optional(),
  // v2 W: above this price (SGD minor) a want's default wait is 30 days
  want_long_wait_threshold_minor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
});

setup.put("/settings", async (c) => {
  const p = settingsSchema.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ error: p.error.flatten() }, 400);
  if (p.data.push_post_purchase !== undefined) await setSetting(c.env.DB, "push_post_purchase", p.data.push_post_purchase ? "1" : "0");
  if (p.data.push_weekly_digest !== undefined) await setSetting(c.env.DB, "push_weekly_digest", p.data.push_weekly_digest ? "1" : "0");
  if (p.data.alert_thresholds) await setSetting(c.env.DB, "alert_thresholds", parseThresholds(p.data.alert_thresholds.join(",")).join(","));
  if (p.data.week_start !== undefined) await setSetting(c.env.DB, "week_start", String(p.data.week_start));
  if (p.data.allowance_override_minor !== undefined) {
    if (p.data.allowance_override_minor) await setSetting(c.env.DB, "allowance_override_minor", String(p.data.allowance_override_minor));
    else await deleteSetting(c.env.DB, "allowance_override_minor");
  }
  if (p.data.allowance_carry !== undefined) await setSetting(c.env.DB, "allowance_carry", p.data.allowance_carry ? "1" : "0");
  if (p.data.nudge_daily_limit !== undefined) await setSetting(c.env.DB, "nudge_daily_limit", String(p.data.nudge_daily_limit));
  if (p.data.quiet_start !== undefined) await setSetting(c.env.DB, "quiet_start", p.data.quiet_start);
  if (p.data.quiet_end !== undefined) await setSetting(c.env.DB, "quiet_end", p.data.quiet_end);
  if (p.data.want_long_wait_threshold_minor !== undefined) await setSetting(c.env.DB, "want_long_wait_threshold_minor", String(p.data.want_long_wait_threshold_minor));
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
