import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { addMonths, emergencyTarget, goalTarget, horizonFor, monthlyAverage, projectionPath, retirementTarget, sgtDate, sgtMonth, type GoalKind, type UsualRow } from "@okanary/core";
import { loadRowsBetween } from "../db";
import type { AppEnv } from "../env";
import { loadFundingWarnings, loadGoals, type ContributionRow, type FundingRow, type GoalRow, type GoalView } from "../goals";
import { ulid } from "../util";

export const goals = new Hono<AppEnv>();

const MAX = Number.MAX_SAFE_INTEGER;
const validDate = (s: string) => { const t = new Date(`${s}T00:00:00Z`); return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s; };
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(validDate, "invalid date");
const flag = z.union([z.literal(0), z.literal(1), z.boolean()]).transform((v) => !!v);
const bad = (c: Context<AppEnv>, error: unknown) => c.json({ error }, 400);
const body = (c: Context<AppEnv>) => c.req.json().catch(() => null);

const fields = {
  name: z.string().trim().min(1).max(80),
  emoji: z.string().trim().max(16).nullable(),
  kind: z.enum(["emergency", "short", "mid", "long", "retirement"]),
  target_today_minor: z.number().int().min(1).max(MAX),
  retirement_monthly_minor: z.number().int().min(1).max(MAX / 300),
  target_date: isoDate.nullable(),
  inflation_bp: z.number().int().min(0).max(2000).nullable(),
  return_bp: z.number().int().min(0).max(3000).nullable(),
  priority: z.number().int().min(1).max(10_000),
  receives_underspend: flag,
};
const createSchema = z.object({
  name: fields.name, emoji: fields.emoji.optional(), kind: fields.kind,
  target_today_minor: fields.target_today_minor.optional(), retirement_monthly_minor: fields.retirement_monthly_minor.optional(),
  target_date: fields.target_date.optional(), inflation_bp: fields.inflation_bp.optional(), return_bp: fields.return_bp.optional(),
  priority: fields.priority.optional(), receives_underspend: fields.receives_underspend.optional(),
});
const patchSchema = z.object({
  name: fields.name, emoji: fields.emoji, kind: fields.kind,
  target_today_minor: fields.target_today_minor, retirement_monthly_minor: fields.retirement_monthly_minor,
  target_date: fields.target_date, inflation_bp: fields.inflation_bp, return_bp: fields.return_bp,
  priority: fields.priority, receives_underspend: fields.receives_underspend, archived: flag,
}).partial();

const getRow = (db: D1Database, id: string) => db.prepare("SELECT * FROM goals WHERE id = ?").bind(id).first<GoalRow>();
const clearUnderspend = (db: D1Database) => db.prepare("UPDATE goals SET receives_underspend = 0 WHERE receives_underspend = 1");

async function viewOf(db: D1Database, now: Date, id: string): Promise<GoalView | null> {
  return (await loadGoals(db, now)).goals.find((g) => g.id === id) ?? null;
}

// ---------------------------------------------------------------- reading

goals.get("/goals", async (c) => c.json(await loadGoals(c.env.DB, c.var.deps.now())));

/** Emergency fund suggestion: 6 × the average monthly Essentials spend over the last up-to-6 complete months with data. */
goals.get("/goals/emergency-suggestion", async (c) => {
  const now = c.var.deps.now();
  const month = sgtMonth(now);
  const rows = await loadRowsBetween(c.env.DB, addMonths(month, -13), month);
  const { average, months } = monthlyAverage(rows as unknown as UsualRow[], now, (r) => r.group_id === "essentials", { maxMonths: 6, lookback: 12 });
  return c.json({ average, months, target: emergencyTarget(average) });
});

goals.get("/goals/:id", async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  const view = await viewOf(db, c.var.deps.now(), id);
  if (!view) return c.json({ error: "not found" }, 404);
  const history = (await db.prepare("SELECT date, value_sgd_minor FROM goal_snapshots WHERE goal_id = ? ORDER BY date").bind(id).all<{ date: string; value_sgd_minor: number }>()).results;
  const contributions = (await db.prepare("SELECT * FROM goal_contributions WHERE goal_id = ? ORDER BY created_at DESC, id DESC").bind(id).all<ContributionRow>()).results;
  const pace = view.pace ?? 0;
  const months = Math.min(view.status.monthsLeft, 600);
  const path = projectionPath(view.value, pace, view.return_bp, months);
  const cone = view.horizon === "long"
    ? { conservative: projectionPath(view.value, pace, Math.max(0, view.return_bp - 200), months), optimistic: projectionPath(view.value, pace, view.return_bp + 200, months) }
    : null;
  return c.json({ ...view, history, contributions, path, cone });
});

// ---------------------------------------------------------------- goals CRUD

interface Editable {
  name: string; emoji: string | null; kind: GoalKind; target_today_minor: number; target_date: string | null;
  inflation_bp: number | null; return_bp: number | null; priority: number; receives_underspend: boolean; archived: boolean;
}

goals.post("/goals", async (c) => {
  const p = createSchema.safeParse(await body(c));
  if (!p.success) return bad(c, p.error.flatten());
  const d = p.data;
  const targetToday = d.kind === "retirement" && d.retirement_monthly_minor != null ? retirementTarget(d.retirement_monthly_minor) : d.target_today_minor;
  if (targetToday == null) return bad(c, d.kind === "retirement" ? "target_today_minor or retirement_monthly_minor is required" : "target_today_minor is required");
  const db = c.env.DB;
  const now = c.var.deps.now();
  const today = sgtDate(now);
  const targetDate = d.target_date ?? null;
  const inflation = d.inflation_bp ?? null;

  const stmts: D1PreparedStatement[] = [];
  let priority = d.priority;
  if (priority == null) {
    if (d.kind === "emergency") {
      priority = 1;
      stmts.push(db.prepare("UPDATE goals SET priority = priority + 1 WHERE archived = 0"));
    } else {
      priority = ((await db.prepare("SELECT MAX(priority) AS m FROM goals WHERE archived = 0").first<{ m: number | null }>())?.m ?? 0) + 1;
    }
  }
  if (d.receives_underspend) stmts.push(clearUnderspend(db));
  const id = ulid(now.getTime());
  stmts.push(db.prepare(
    `INSERT INTO goals (id, name, emoji, target_sgd_minor, target_date, receives_underspend, archived, created_at, horizon, priority, target_today_minor, inflation_bp, return_bp, kind, start_date)
     VALUES (?,?,?,?,?,?,0,?,?,?,?,?,?,?,?)`,
  ).bind(
    id, d.name, d.emoji || null, goalTarget({ kind: d.kind, target_today_minor: targetToday, inflation_bp: inflation, target_date: targetDate }, today), targetDate, d.receives_underspend ? 1 : 0,
    now.toISOString(), horizonFor(targetDate, today, d.kind), priority, targetToday, inflation, d.return_bp ?? null, d.kind, today,
  ));
  await db.batch(stmts);
  return c.json(await viewOf(db, now, id), 201);
});

goals.patch("/goals/:id", async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  const row = await getRow(db, id);
  if (!row) return c.json({ error: "not found" }, 404);
  const p = patchSchema.safeParse(await body(c));
  if (!p.success) return bad(c, p.error.flatten());
  const d = p.data;
  const now = c.var.deps.now();
  const today = sgtDate(now);
  const next: Editable = {
    name: d.name ?? row.name, emoji: d.emoji !== undefined ? d.emoji || null : row.emoji, kind: d.kind ?? row.kind,
    target_today_minor: d.retirement_monthly_minor != null ? retirementTarget(d.retirement_monthly_minor) : d.target_today_minor ?? row.target_today_minor,
    target_date: d.target_date !== undefined ? d.target_date : row.target_date,
    inflation_bp: d.inflation_bp !== undefined ? d.inflation_bp : row.inflation_bp,
    return_bp: d.return_bp !== undefined ? d.return_bp : row.return_bp,
    priority: d.priority ?? row.priority,
    receives_underspend: d.receives_underspend ?? !!row.receives_underspend,
    archived: d.archived ?? !!row.archived,
  };
  if (next.archived) next.receives_underspend = false; // an archived goal can't receive pledges
  const stmts: D1PreparedStatement[] = [];
  if (next.receives_underspend && !row.receives_underspend) stmts.push(clearUnderspend(db));
  stmts.push(db.prepare(
    `UPDATE goals SET name = ?, emoji = ?, kind = ?, target_today_minor = ?, target_date = ?, inflation_bp = ?, return_bp = ?, priority = ?, receives_underspend = ?, archived = ?,
       horizon = ?, target_sgd_minor = ? WHERE id = ?`,
  ).bind(
    next.name, next.emoji, next.kind, next.target_today_minor, next.target_date, next.inflation_bp, next.return_bp, next.priority, next.receives_underspend ? 1 : 0, next.archived ? 1 : 0,
    horizonFor(next.target_date, today, next.kind), goalTarget(next, today), id,
  ));
  await db.batch(stmts);
  const view = await viewOf(db, now, id);
  return c.json(view ?? { id, archived: true });
});

goals.delete("/goals/:id", async (c) => {
  const id = c.req.param("id");
  const r = await c.env.DB.prepare("UPDATE goals SET archived = 1, receives_underspend = 0 WHERE id = ?").bind(id).run();
  if (!r.meta.changes) return c.json({ error: "not found" }, 404);
  return c.json({ id, archived: true });
});

/** ids in the new order → priorities 1..n; goals not listed follow in their current order. */
goals.post("/goals/reorder", async (c) => {
  const p = z.object({ ids: z.array(z.string().min(1)).min(1).max(200) }).safeParse(await body(c));
  if (!p.success) return bad(c, p.error.flatten());
  const db = c.env.DB;
  const live = (await db.prepare("SELECT id FROM goals WHERE archived = 0 ORDER BY priority, created_at, id").all<{ id: string }>()).results.map((r) => r.id);
  const known = new Set(live);
  if (new Set(p.data.ids).size !== p.data.ids.length) return bad(c, "duplicate ids");
  if (p.data.ids.some((id) => !known.has(id))) return bad(c, "unknown goal");
  const order = [...p.data.ids, ...live.filter((id) => !p.data.ids.includes(id))];
  await db.batch(order.map((id, i) => db.prepare("UPDATE goals SET priority = ? WHERE id = ?").bind(i + 1, id)));
  return c.json({ order });
});

/** Exclusively mark (or unmark) the goal that receives weekly underspend pledges. */
goals.post("/goals/:id/underspend", async (c) => {
  const p = z.object({ on: flag }).safeParse(await body(c));
  if (!p.success) return bad(c, p.error.flatten());
  const db = c.env.DB;
  const id = c.req.param("id");
  const row = await getRow(db, id);
  if (!row || row.archived) return c.json({ error: "not found" }, 404);
  if (p.data.on) await db.batch([clearUnderspend(db), db.prepare("UPDATE goals SET receives_underspend = 1 WHERE id = ?").bind(id)]);
  else await db.prepare("UPDATE goals SET receives_underspend = 0 WHERE id = ?").bind(id).run();
  return c.json({ id, receives_underspend: p.data.on });
});

// ---------------------------------------------------------------- funding links

const fundingSchema = z.object({
  source_type: z.enum(["nw_account", "holding", "earmark"]),
  source_id: z.string().min(1),
  share_bp: z.number().int().min(1).max(10000).optional(),
  earmark_minor: z.number().int().min(1).max(MAX).optional(),
});

goals.post("/goals/:id/funding", async (c) => {
  const db = c.env.DB;
  const goalId = c.req.param("id");
  const goal = await getRow(db, goalId);
  if (!goal || goal.archived) return c.json({ error: "not found" }, 404);
  const p = fundingSchema.safeParse(await body(c));
  if (!p.success) return bad(c, p.error.flatten());
  const d = p.data;
  if (d.source_type === "earmark" && d.earmark_minor == null) return bad(c, "earmark_minor is required for an earmark");
  const exists = await db.prepare(d.source_type === "holding" ? "SELECT 1 AS x FROM holdings WHERE id = ?" : "SELECT 1 AS x FROM nw_accounts WHERE id = ?").bind(d.source_id).first();
  if (!exists) return bad(c, d.source_type === "holding" ? "unknown holding" : "unknown net worth account");
  const dup = await db.prepare("SELECT 1 AS x FROM goal_funding WHERE goal_id = ? AND source_type = ? AND source_id = ?").bind(goalId, d.source_type, d.source_id).first();
  if (dup) return c.json({ error: "already linked" }, 409);
  const link: FundingRow = {
    id: ulid(c.var.deps.now().getTime()), goal_id: goalId, source_type: d.source_type, source_id: d.source_id,
    share_bp: d.source_type === "earmark" ? null : d.share_bp ?? 10000, earmark_minor: d.source_type === "earmark" ? d.earmark_minor! : null,
  };
  await db.prepare("INSERT INTO goal_funding (id, goal_id, source_type, source_id, share_bp, earmark_minor) VALUES (?,?,?,?,?,?)")
    .bind(link.id, link.goal_id, link.source_type, link.source_id, link.share_bp, link.earmark_minor).run();
  // Over-allocation is a warning, not an error.
  return c.json({ link, warnings: await loadFundingWarnings(db, c.var.deps.now()) }, 201);
});

goals.delete("/goal-funding/:id", async (c) => {
  const r = await c.env.DB.prepare("DELETE FROM goal_funding WHERE id = ?").bind(c.req.param("id")).run();
  if (!r.meta.changes) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true, warnings: await loadFundingWarnings(c.env.DB, c.var.deps.now()) });
});

// ---------------------------------------------------------------- contributions (progress counts transferred only)

const contributionSchema = z.object({
  amount_sgd_minor: z.number().int().min(1).max(MAX),
  status: z.enum(["transferred", "pledged"]).default("transferred"),
  period: z.string().trim().min(1).max(20).default("manual"),
});

goals.post("/goals/:id/contributions", async (c) => {
  const db = c.env.DB;
  const goalId = c.req.param("id");
  const goal = await getRow(db, goalId);
  if (!goal || goal.archived) return c.json({ error: "not found" }, 404);
  const p = contributionSchema.safeParse(await body(c));
  if (!p.success) return bad(c, p.error.flatten());
  const now = c.var.deps.now().toISOString();
  const row: ContributionRow = {
    id: ulid(c.var.deps.now().getTime()), goal_id: goalId, period: p.data.period, amount_sgd_minor: p.data.amount_sgd_minor, source: "manual",
    status: p.data.status, created_at: now, resolved_at: p.data.status === "transferred" ? now : null,
  };
  await db.prepare("INSERT INTO goal_contributions (id, goal_id, period, amount_sgd_minor, source, status, created_at, resolved_at) VALUES (?,?,?,?,?,?,?,?)")
    .bind(row.id, row.goal_id, row.period, row.amount_sgd_minor, row.source, row.status, row.created_at, row.resolved_at).run();
  return c.json(row, 201);
});

async function resolve(c: Context<AppEnv>, status: "transferred" | "skipped") {
  const db = c.env.DB;
  const id = c.req.param("id")!;
  const row = await db.prepare("SELECT * FROM goal_contributions WHERE id = ?").bind(id).first<ContributionRow>();
  if (!row) return c.json({ error: "not found" }, 404);
  if (row.status !== "pledged") return c.json({ error: `already ${row.status}` }, 409);
  const at = c.var.deps.now().toISOString();
  await db.prepare("UPDATE goal_contributions SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pledged'").bind(status, at, id).run();
  return c.json({ ...row, status, resolved_at: at });
}
goals.post("/goal-contributions/:id/transfer", (c) => resolve(c, "transferred"));
goals.post("/goal-contributions/:id/skip", (c) => resolve(c, "skipped"));
