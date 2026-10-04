import { Hono, type Context } from "hono";
import { z } from "zod";
import { convertMinor, decideAfter, defaultWaitDays, isSpend, sgtMonth, sgtParts, skippedTotal, suggestTransactionMatch, transition, type SpendRow } from "@okanary/core";
import { TXN_WITH_GROUP_SQL } from "../db";
import type { AppEnv } from "../env";
import { getSgdRate } from "../fx";
import { loadGoals } from "../goals";
import { ulid } from "../util";
import { getWant, loadLongWaitThreshold, withLeft, type WantRow } from "../wants";

/**
 * Want list (v2 W). Timestamps come from deps.now(). A want with wait_days 0 stays 'waiting' with decide_after = 00:00 SGT today
 * (decideAfter handles 0); the hourly ready step (runWantsReady) turns it 'ready', so there is one path to 'ready'.
 */
export const wants = new Hono<AppEnv>();

const MAX = Number.MAX_SAFE_INTEGER;
const money = z.number().int().min(1).max(MAX);
const fields = {
  name: z.string().trim().min(1).max(120),
  price_minor: money,
  currency: z.string().length(3).transform((s) => s.toUpperCase()),
  /** non-SGD only: the SGD value as typed (kept as is); omitted -> converted at the ECB rate */
  price_sgd_minor: money,
  url: z.string().trim().max(500).nullable(),
  note: z.string().trim().max(1000).nullable(),
  category_id: z.string().min(1).max(64).nullable(),
  wait_days: z.number().int().min(0).max(365),
};
const createSchema = z.object({
  name: fields.name, price_minor: fields.price_minor, currency: fields.currency.default("SGD"), price_sgd_minor: fields.price_sgd_minor.optional(),
  url: fields.url.optional(), note: fields.note.optional(), category_id: fields.category_id.optional(), wait_days: fields.wait_days.optional(),
});
const patchSchema = z.object({
  name: fields.name, price_minor: fields.price_minor, currency: fields.currency, price_sgd_minor: fields.price_sgd_minor,
  url: fields.url, note: fields.note, category_id: fields.category_id, wait_days: fields.wait_days,
}).partial();

const body = (c: Context<AppEnv>) => c.req.json().catch(() => null);
const notFound = (c: Context<AppEnv>) => c.json({ error: "not found" }, 404);
const emptyToNull = (s: string | null | undefined) => (s == null || s === "" ? null : s);

async function categoryExists(db: D1Database, id: string | null | undefined): Promise<boolean> {
  if (!id) return true;
  return !!(await db.prepare("SELECT 1 AS x FROM categories WHERE id = ?").bind(id).first());
}

/** SGD value of a price: SGD as is; otherwise the explicit value, else the ECB rate. null = no rate known (-> 422). */
async function priceSgd(c: Context<AppEnv>, price: number, currency: string, explicit: number | undefined, at: Date): Promise<number | null> {
  if (currency === "SGD") return price;
  if (explicit != null) return explicit;
  const r = await getSgdRate(c.env.DB, currency, at, c.var.deps.fetch);
  return r ? convertMinor(price, currency, "SGD", r.rate) : null;
}
const FX_422 = { error: "fx rate unavailable: provide price_sgd_minor" };

// ---------------------------------------------------------------- reading

/** The receiving goal (loadGoals' receiving_goal_id), as the skip offer / list header shows it. */
async function receivingGoal(db: D1Database, now: Date): Promise<{ id: string; name: string; emoji: string | null } | null> {
  const { goals, receiving_goal_id } = await loadGoals(db, now);
  const g = goals.find((x) => x.id === receiving_goal_id);
  return g ? { id: g.id, name: g.name, emoji: g.emoji } : null;
}

async function yearStats(db: D1Database, now: Date) {
  const year = sgtParts(now).year;
  const skipped = (await db.prepare("SELECT status, price_sgd_minor, decided_at FROM wants WHERE status = 'skipped'").all<Pick<WantRow, "status" | "price_sgd_minor" | "decided_at">>()).results;
  const s = skippedTotal(skipped, year);
  return { year, skipped_total_minor: s.total, skipped_count: s.count };
}

wants.get("/wants", async (c) => {
  const now = c.var.deps.now();
  const db = c.env.DB;
  const rows = (await db.prepare("SELECT * FROM wants WHERE status IN ('waiting','ready') ORDER BY decide_after, added_at, id").all<WantRow>()).results;
  const decided = (await db.prepare("SELECT * FROM wants WHERE status IN ('bought','skipped') ORDER BY decided_at DESC, id DESC LIMIT 100").all<WantRow>()).results;
  return c.json({
    waiting: rows.filter((w) => w.status === "waiting").map((w) => withLeft(w, now)),
    ready: rows.filter((w) => w.status === "ready").map((w) => withLeft(w, now)),
    decided: decided.map((w) => withLeft(w, now)),
    stats: await yearStats(db, now),
    receiving_goal: await receivingGoal(db, now),
  });
});

/** Light endpoint for Home / Reports: "Not bought this year". */
wants.get("/wants/stats", async (c) => c.json(await yearStats(c.env.DB, c.var.deps.now())));

// ---------------------------------------------------------------- create / edit / delete

wants.post("/wants", async (c) => {
  const p = createSchema.safeParse(await body(c));
  if (!p.success) return c.json({ error: p.error.flatten() }, 400);
  const d = p.data;
  const now = c.var.deps.now();
  if (!(await categoryExists(c.env.DB, d.category_id))) return c.json({ error: "unknown category" }, 400);
  const sgd = await priceSgd(c, d.price_minor, d.currency, d.price_sgd_minor, now);
  if (sgd == null) return c.json(FX_422, 422);
  const waitDays = d.wait_days ?? defaultWaitDays(sgd, await loadLongWaitThreshold(c.env.DB));
  const added = now.toISOString();
  const id = ulid(now.getTime());
  await c.env.DB.prepare(
    `INSERT INTO wants (id, name, price_minor, currency, price_sgd_minor, url, note, category_id, wait_days, added_at, decide_after, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?, 'waiting')`,
  ).bind(id, d.name, d.price_minor, d.currency, sgd, emptyToNull(d.url), emptyToNull(d.note), d.category_id ?? null, waitDays, added, decideAfter(added, waitDays)).run();
  return c.json(withLeft((await getWant(c.env.DB, id))!, now), 201);
});

wants.patch("/wants/:id", async (c) => {
  const w = await getWant(c.env.DB, c.req.param("id"));
  if (!w) return notFound(c);
  if (w.status === "bought" || w.status === "skipped") return c.json({ error: "decided wants can't be edited" }, 409);
  const p = patchSchema.safeParse(await body(c));
  if (!p.success) return c.json({ error: p.error.flatten() }, 400);
  const d = p.data;
  const now = c.var.deps.now();
  if (d.category_id !== undefined && !(await categoryExists(c.env.DB, d.category_id))) return c.json({ error: "unknown category" }, 400);
  const next = { ...w };
  if (d.name !== undefined) next.name = d.name;
  if (d.url !== undefined) next.url = emptyToNull(d.url);
  if (d.note !== undefined) next.note = emptyToNull(d.note);
  if (d.category_id !== undefined) next.category_id = d.category_id;
  if (d.price_minor !== undefined || d.currency !== undefined || d.price_sgd_minor !== undefined) {
    next.price_minor = d.price_minor ?? w.price_minor;
    next.currency = d.currency ?? w.currency;
    const sgd = await priceSgd(c, next.price_minor, next.currency, d.price_sgd_minor, now);
    if (sgd == null) return c.json(FX_422, 422);
    next.price_sgd_minor = sgd;
  }
  if (d.wait_days !== undefined) {
    // recomputed from the original added_at; a 'ready' want whose new date is still ahead goes back to waiting
    next.wait_days = d.wait_days;
    next.decide_after = decideAfter(w.added_at, d.wait_days);
    if (next.status === "ready" && Date.parse(next.decide_after) > now.getTime()) next.status = "waiting";
  }
  await c.env.DB.prepare("UPDATE wants SET name=?, price_minor=?, currency=?, price_sgd_minor=?, url=?, note=?, category_id=?, wait_days=?, decide_after=?, status=? WHERE id=?")
    .bind(next.name, next.price_minor, next.currency, next.price_sgd_minor, next.url, next.note, next.category_id, next.wait_days, next.decide_after, next.status, w.id).run();
  return c.json(withLeft((await getWant(c.env.DB, w.id))!, now));
});

wants.delete("/wants/:id", async (c) => {
  const r = await c.env.DB.prepare("DELETE FROM wants WHERE id = ?").bind(c.req.param("id")).run();
  return r.meta.changes ? c.json({ ok: true }) : notFound(c);
});

// ---------------------------------------------------------------- decisions

type TxnRow = SpendRow & { id: string; occurred_at: string; merchant: string | null; merchant_raw: string | null; amount_minor: number; currency: string; category_id: string | null };

const DAY = 86400_000;
const MATCH_DAYS = 14;

/** Spend transactions (not void; the shared spend definition) within ±14 days of `at`, minus ones already linked to a want. */
async function candidateTxns(db: D1Database, at: string): Promise<TxnRow[]> {
  const t = Date.parse(at);
  const rows = (await db.prepare(`${TXN_WITH_GROUP_SQL} WHERE t.occurred_at >= ? AND t.occurred_at <= ? AND t.id NOT IN (SELECT transaction_id FROM wants WHERE transaction_id IS NOT NULL)`)
    .bind(new Date(t - MATCH_DAYS * DAY).toISOString(), new Date(t + MATCH_DAYS * DAY).toISOString()).all<TxnRow>()).results;
  return rows.filter((r) => isSpend(r));
}

const matchesFor = async (db: D1Database, w: WantRow) =>
  w.decided_at ? suggestTransactionMatch({ price_sgd_minor: w.price_sgd_minor, decided_at: w.decided_at }, await candidateTxns(db, w.decided_at)) : [];

wants.post("/wants/:id/buy", async (c) => {
  const w = await getWant(c.env.DB, c.req.param("id"));
  if (!w) return notFound(c);
  const p = z.object({ confirm_early: z.boolean().optional() }).safeParse((await body(c)) ?? {});
  if (!p.success) return c.json({ error: p.error.flatten() }, 400);
  const now = c.var.deps.now();
  const t = transition(w, "buy", now, { confirmEarly: p.data.confirm_early });
  if (!t.ok) {
    if (t.error === "confirm_early") return c.json({ error: "confirm_early", message: "Bought before the wait ended?" }, 409);
    return c.json({ error: t.error, message: "Already decided" }, 409);
  }
  await c.env.DB.prepare("UPDATE wants SET status = ?, bought_early = ?, decided_at = ? WHERE id = ?").bind(t.status, t.bought_early ? 1 : 0, now.toISOString(), w.id).run();
  const want = (await getWant(c.env.DB, w.id))!;
  return c.json({ want: withLeft(want, now), matches: await matchesFor(c.env.DB, want) });
});

wants.post("/wants/:id/skip", async (c) => {
  const w = await getWant(c.env.DB, c.req.param("id"));
  if (!w) return notFound(c);
  const now = c.var.deps.now();
  const t = transition(w, "skip", now);
  if (!t.ok) return c.json({ error: t.error, message: "Already decided" }, 409);
  await c.env.DB.prepare("UPDATE wants SET status = 'skipped', decided_at = ? WHERE id = ?").bind(now.toISOString(), w.id).run();
  const want = (await getWant(c.env.DB, w.id))!;
  const g = await receivingGoal(c.env.DB, now);
  return c.json({ want: withLeft(want, now), offer: g ? { goal_id: g.id, name: g.name, emoji: g.emoji, amount: want.price_sgd_minor } : null });
});

/** Skipped want -> a 'pledged' want_skipped contribution on a goal (G pledge flow). One per want: the contribution id is `want:<id>`. */
wants.post("/wants/:id/pledge", async (c) => {
  const w = await getWant(c.env.DB, c.req.param("id"));
  if (!w) return notFound(c);
  const p = z.object({ goal_id: z.string().min(1) }).safeParse(await body(c));
  if (!p.success) return c.json({ error: p.error.flatten() }, 400);
  if (w.status !== "skipped" || !w.decided_at) return c.json({ error: "only a skipped want can be pledged" }, 409);
  const goal = await c.env.DB.prepare("SELECT id FROM goals WHERE id = ? AND archived = 0").bind(p.data.goal_id).first();
  if (!goal) return c.json({ error: "unknown goal" }, 400);
  const now = c.var.deps.now();
  const id = `want:${w.id}`;
  const r = await c.env.DB.prepare("INSERT OR IGNORE INTO goal_contributions (id, goal_id, period, amount_sgd_minor, source, status, created_at) VALUES (?,?,?,?,'want_skipped','pledged',?)")
    .bind(id, p.data.goal_id, sgtMonth(w.decided_at), w.price_sgd_minor, now.toISOString()).run();
  if (!r.meta.changes) return c.json({ error: "already_pledged", message: "This one is already added to a goal" }, 409);
  return c.json({ ok: true, pledge_id: id, goal_id: p.data.goal_id, amount: w.price_sgd_minor }, 201);
});

// ---------------------------------------------------------------- linking a purchase

wants.get("/wants/:id/matches", async (c) => {
  const w = await getWant(c.env.DB, c.req.param("id"));
  if (!w) return notFound(c);
  if (w.status !== "bought" || w.transaction_id) return c.json({ matches: [] });
  return c.json({ matches: await matchesFor(c.env.DB, w) });
});

wants.post("/wants/:id/link", async (c) => {
  const w = await getWant(c.env.DB, c.req.param("id"));
  if (!w) return notFound(c);
  const p = z.object({ transaction_id: z.string().min(1) }).safeParse(await body(c));
  if (!p.success) return c.json({ error: p.error.flatten() }, 400);
  if (w.status !== "bought") return c.json({ error: "only a bought want can be linked" }, 409);
  if (!(await c.env.DB.prepare("SELECT 1 AS x FROM transactions WHERE id = ?").bind(p.data.transaction_id).first())) return c.json({ error: "unknown transaction" }, 400);
  await c.env.DB.prepare("UPDATE wants SET transaction_id = ? WHERE id = ?").bind(p.data.transaction_id, w.id).run();
  return c.json(withLeft((await getWant(c.env.DB, w.id))!, c.var.deps.now()));
});
