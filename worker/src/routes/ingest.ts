import { Hono } from "hono";
import { z } from "zod";
import { parseShortcutAmount } from "@okanary/core";
import { captureTransaction, pushPurchaseNudge } from "../capture";
import type { AppEnv } from "../env";
import { getSetting } from "../settings";
import { ulid } from "../util";

export const ingest = new Hono<AppEnv>();

// ---- auth: bearer INGEST_TOKEN, constant-time, plus a best-effort per-isolate rate limit ----
async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i]! ^ y[i]!;
  return d === 0;
}

/** The token rotated from Settings (stored in D1) wins; the INGEST_TOKEN secret is the bootstrap value. */
export async function effectiveIngestToken(db: D1Database, envToken?: string): Promise<string | null> {
  return (await getSetting(db, "ingest_token")) ?? envToken ?? null;
}

const hits: number[] = [];
export const _resetRateLimit = () => { hits.length = 0; };
const RATE_LIMIT = 60; // per minute per isolate; add a Cloudflare WAF rate-limit rule for a hard cap (README)
function rateLimited(now: number): boolean {
  while (hits.length && now - hits[0]! > 60_000) hits.shift();
  if (hits.length >= RATE_LIMIT) return true;
  hits.push(now);
  return false;
}

ingest.use("*", async (c, next) => {
  const token = await effectiveIngestToken(c.env.DB, c.env.INGEST_TOKEN);
  if (!token) return c.json({ error: "ingest not configured" }, 503);
  const m = /^Bearer\s+(.+)$/i.exec(c.req.header("authorization") ?? "");
  if (!m || !(await safeEqual(m[1]!.trim(), token))) return c.json({ error: "unauthorized" }, 401);
  if (rateLimited(c.var.deps.now().getTime())) return c.json({ error: "rate limited" }, 429);
  await next();
});

const applePaySchema = z.object({
  amount: z.union([z.string(), z.number()]),
  merchant: z.string().max(300).default(""),
  card: z.string().max(200).default(""),
  ts: z.string().max(100).optional(),
});

/** Wallet card name -> account: wallet_card_name, then account name, then a last4 mentioned in the card text. */
async function matchAccount(db: D1Database, card: string): Promise<string | null> {
  if (!card.trim()) return null;
  const accts = (await db.prepare("SELECT id, name, last4, wallet_card_name FROM accounts WHERE archived = 0").all<{ id: string; name: string; last4: string | null; wallet_card_name: string | null }>()).results;
  const c = card.trim().toLowerCase();
  return (
    accts.find((a) => a.wallet_card_name && a.wallet_card_name.trim().toLowerCase() === c)?.id ??
    accts.find((a) => a.name.trim().toLowerCase() === c)?.id ??
    accts.find((a) => a.last4 && c.includes(a.last4))?.id ??
    null
  );
}

ingest.post("/applepay", async (c) => {
  const deps = c.var.deps;
  const rawText = await c.req.text();
  const rawId = ulid();
  const received = deps.now().toISOString();
  const logRaw = (status: string, error: string | null) =>
    c.env.DB.prepare("INSERT INTO raw_ingest (id, source, received_at, payload, parse_status, error) VALUES (?,?,?,?,?,?)").bind(rawId, "applepay", received, rawText, status, error).run();

  let body: z.infer<typeof applePaySchema>;
  try {
    body = applePaySchema.parse(JSON.parse(rawText));
  } catch {
    await logRaw("failed", "invalid JSON payload");
    return c.json({ error: "invalid payload" }, 400);
  }
  const amt = parseShortcutAmount(body.amount);
  if (!amt) {
    await logRaw("failed", "could not parse amount");
    return c.json({ error: "could not parse amount" }, 422);
  }

  // A retried POST carries the identical payload (incl. ts to the second): return the original instead of double counting.
  const dup = await c.env.DB.prepare("SELECT transaction_id FROM raw_ingest WHERE source = 'applepay' AND payload = ? AND transaction_id IS NOT NULL AND received_at > ? LIMIT 1")
    .bind(rawText, new Date(deps.now().getTime() - 5 * 60_000).toISOString()).first<{ transaction_id: string }>();
  if (dup) return c.json({ id: dup.transaction_id, duplicate: true }, 200);

  await logRaw("received", null);
  const now = deps.now();
  let occurred = now.toISOString();
  if (body.ts) {
    const ms = Date.parse(body.ts);
    if (!Number.isNaN(ms) && Math.abs(ms - now.getTime()) < 36 * 3600_000) occurred = new Date(ms).toISOString();
  }

  const t = await captureTransaction(c.env, deps, {
    source: "applepay", occurred_at: occurred, amount_minor: amt.amount_minor, currency: amt.currency,
    merchant_raw: body.merchant, account_id: await matchAccount(c.env.DB, body.card), status: "pending", raw_id: rawId,
  });

  const push = pushPurchaseNudge(c.env, deps, t).catch(() => undefined);
  try { c.executionCtx.waitUntil(push); } catch { await push; }
  return c.json({ id: t.id, status: t.status, category_id: t.category_id, category_source: t.category_source, merchant: t.merchant }, 201);
});
