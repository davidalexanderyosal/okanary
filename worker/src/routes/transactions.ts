import { Hono, type Context } from "hono";
import { z } from "zod";
import { convertMinor, monthRangeUtc, normalizeMerchant, type Transaction } from "@okanary/core";
import { runAlertsInBackground } from "../alerts";
import { getSgdRate } from "../fx";
import { tripCovering } from "../trips";
import type { AppEnv } from "../env";
import { getTransaction, TXN_WITH_GROUP_SQL } from "../db";
import { nowIso, ulid } from "../util";

const money = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const flag = z.union([z.literal(0), z.literal(1), z.boolean()]).transform((v) => (v ? 1 : 0));

const createSchema = z.object({
  amount_minor: money.refine((n) => n > 0, "amount must be > 0"),
  currency: z.string().length(3).transform((s) => s.toUpperCase()).default("SGD"),
  /** Optional for non-SGD: omitted -> converted at the cached ECB rate (fx_source 'ecb'); given -> kept as typed (fx_source 'manual'). */
  amount_sgd_minor: money.optional(),
  occurred_at: z.string().datetime().optional(),
  account_id: z.string().nullable().optional(),
  trip_id: z.string().nullable().optional(),
  merchant: z.string().max(200).nullable().optional(),
  category_id: z.string().nullable().optional(),
  note: z.string().max(1000).nullable().optional(),
  is_refund: flag.optional(),
  is_reimbursable: flag.optional(),
  is_excluded: flag.optional(),
});

const patchSchema = createSchema.partial().extend({
  status: z.enum(["pending", "needs_review", "confirmed", "void"]).optional(),
});

export const transactions = new Hono<AppEnv>();

/** Budget threshold check after a write; runs in the background so the response isn't delayed. */
async function alertsAfterWrite(c: Context<AppEnv, any>): Promise<void> {
  let ctx: { waitUntil(p: Promise<unknown>): void } | undefined;
  try { ctx = c.executionCtx; } catch { /* no ExecutionContext (tests): run inline */ }
  await runAlertsInBackground(c.env, c.var.deps, ctx); // with a ctx this returns at once (waitUntil); without one it runs inline
}

transactions.get("/", async (c) => {
  const q = c.req.query();
  const where: string[] = [];
  const binds: unknown[] = [];
  if (q.month) {
    if (!/^\d{4}-\d{2}$/.test(q.month)) return c.json({ error: "bad month" }, 400);
    const r = monthRangeUtc(q.month);
    where.push("t.occurred_at >= ? AND t.occurred_at < ?");
    binds.push(r.start, r.end);
  }
  if (q.group) { where.push("c.group_id = ?"); binds.push(q.group); }
  if (q.category) { where.push("t.category_id = ?"); binds.push(q.category); }
  if (q.account) { where.push("t.account_id = ?"); binds.push(q.account); }
  if (q.source) { where.push("t.source = ?"); binds.push(q.source); }
  if (q.trip) { where.push("t.trip_id = ?"); binds.push(q.trip); }
  if (q.q) { where.push("(t.merchant LIKE ? OR t.note LIKE ?)"); binds.push(`%${q.q}%`, `%${q.q}%`); }
  const limit = Math.min(Number(q.limit) || 200, 500);
  const sql = `${TXN_WITH_GROUP_SQL} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY t.occurred_at DESC, t.id DESC LIMIT ?`;
  const { results } = await c.env.DB.prepare(sql).bind(...binds, limit).all();
  return c.json(results);
});

transactions.get("/:id", async (c) => {
  const t = await getTransaction(c.env.DB, c.req.param("id"));
  return t ? c.json(t) : c.json({ error: "not found" }, 404);
});

transactions.post("/", async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const d = parsed.data;
  const deps = c.var.deps;
  const occurred = d.occurred_at ?? deps.now().toISOString();
  let sgd: number;
  let fxSource: Transaction["fx_source"];
  let fxRate: number | null = null;
  if (d.currency === "SGD") {
    sgd = d.amount_minor;
    fxSource = "same";
  } else if (d.amount_sgd_minor != null) {
    sgd = d.amount_sgd_minor;
    fxSource = "manual";
  } else {
    const r = await getSgdRate(c.env.DB, d.currency, occurred, deps.fetch);
    if (!r) return c.json({ error: "fx rate unavailable: provide amount_sgd_minor" }, 422);
    sgd = convertMinor(d.amount_minor, d.currency, "SGD", r.rate);
    fxRate = r.rate;
    fxSource = "ecb";
  }
  const tripId = d.trip_id !== undefined ? d.trip_id : ((await tripCovering(c.env.DB, occurred))?.id ?? null);
  const now = nowIso();
  const id = ulid();
  const merchantRaw = d.merchant?.trim() || null;
  const merchant = merchantRaw ? normalizeMerchant(merchantRaw) : null; // merchant is the normalised form (spec §4.4)
  await c.env.DB.prepare(
    `INSERT INTO transactions (id, occurred_at, account_id, amount_minor, currency, amount_sgd_minor, fx_rate, fx_source,
       merchant_raw, merchant, category_id, category_source, status, source, is_refund, is_reimbursable, is_excluded, note, trip_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'confirmed','manual',?,?,?,?,?,?,?)`,
  )
    .bind(id, occurred, d.account_id ?? null, d.amount_minor, d.currency, sgd, fxRate, fxSource,
      merchantRaw, merchant, d.category_id ?? null, d.category_id ? "user" : null,
      d.is_refund ?? 0, d.is_reimbursable ?? 0, d.is_excluded ?? 0, d.note ?? null, tripId, now, now)
    .run();
  await alertsAfterWrite(c);
  return c.json(await getTransaction(c.env.DB, id), 201);
});

transactions.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await getTransaction(c.env.DB, id);
  if (!existing) return c.json({ error: "not found" }, 404);
  const parsed = patchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const d = parsed.data;
  const next = { ...existing } as Record<string, unknown>;
  if (d.amount_minor !== undefined) next.amount_minor = d.amount_minor;
  if (d.currency !== undefined) next.currency = d.currency;
  if (d.occurred_at !== undefined) next.occurred_at = d.occurred_at;
  if (d.account_id !== undefined) next.account_id = d.account_id;
  if (d.merchant !== undefined) {
    const raw = d.merchant?.trim() || null;
    next.merchant_raw = raw;
    next.merchant = raw ? normalizeMerchant(raw) : null;
  }
  if (d.category_id !== undefined) { next.category_id = d.category_id; next.category_source = d.category_id ? "user" : null; }
  if (d.note !== undefined) next.note = d.note;
  for (const k of ["is_refund", "is_reimbursable", "is_excluded"] as const) if (d[k] !== undefined) next[k] = d[k];
  if (d.status !== undefined) next.status = d.status;
  // user touching a review item confirms it
  if (d.category_id && existing.status === "needs_review" && d.status === undefined) next.status = "confirmed";
  if (next.currency === "SGD") {
    next.amount_sgd_minor = next.amount_minor;
    next.fx_source = "same";
  } else if (d.amount_sgd_minor !== undefined) {
    next.amount_sgd_minor = d.amount_sgd_minor;
    next.fx_source = "manual";
  } else if (d.amount_minor !== undefined || d.currency !== undefined) {
    const r = await getSgdRate(c.env.DB, String(next.currency), String(next.occurred_at), c.var.deps.fetch);
    if (!r) return c.json({ error: "fx rate unavailable: provide amount_sgd_minor" }, 422);
    next.amount_sgd_minor = convertMinor(Number(next.amount_minor), String(next.currency), "SGD", r.rate);
    next.fx_rate = r.rate;
    next.fx_source = "ecb";
  }
  if (d.trip_id !== undefined) next.trip_id = d.trip_id;
  await c.env.DB.prepare(
    `UPDATE transactions SET occurred_at=?, account_id=?, amount_minor=?, currency=?, amount_sgd_minor=?, fx_source=?, fx_rate=?, trip_id=?,
       merchant_raw=?, merchant=?, category_id=?, category_source=?, status=?, is_refund=?, is_reimbursable=?, is_excluded=?, note=?, updated_at=?
     WHERE id=?`,
  )
    .bind(next.occurred_at, next.account_id, next.amount_minor, next.currency, next.amount_sgd_minor, next.fx_source, next.fx_rate ?? null, next.trip_id ?? null,
      next.merchant_raw, next.merchant, next.category_id, next.category_source, next.status,
      next.is_refund, next.is_reimbursable, next.is_excluded, next.note, nowIso(), id)
    .run();
  await alertsAfterWrite(c);
  return c.json(await getTransaction(c.env.DB, id));
});

transactions.delete("/:id", async (c) => {
  const r = await c.env.DB.prepare(`DELETE FROM transactions WHERE id = ?`).bind(c.req.param("id")).run();
  return r.meta.changes ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});

