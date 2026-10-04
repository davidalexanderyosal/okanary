import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { addMonths, commissionSplit, dayRangeUtc, sgtDate, sgtMonth, sgtWeek } from "@okanary/core";
import { loadAllowanceSettings } from "../allowance";
import type { AppEnv } from "../env";
import { baseIncomeFor, loadSplitGoals, loadSplitRule, monthRe, validSplitRule, type IncomeEventRow, type IncomeSettingRow } from "../plan";
import { setSetting } from "../settings";
import { ulid } from "../util";

export const income = new Hono<AppEnv>();

const MAX = Number.MAX_SAFE_INTEGER;
const validDate = (s: string) => { const t = new Date(`${s}T00:00:00Z`); return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s; };
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(validDate, "invalid date");
const body = (c: Context<AppEnv>) => c.req.json().catch(() => null);
const shiftDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

const eventView = (e: IncomeEventRow) => ({ ...e, split: e.split_json ? JSON.parse(e.split_json) : null });
const getEvent = (db: D1Database, id: string) => db.prepare("SELECT * FROM income_events WHERE id = ?").bind(id).first<IncomeEventRow>();

async function overview(db: D1Database, now: Date) {
  const month = sgtMonth(now);
  const today = sgtDate(now);
  const history = (await db.prepare("SELECT * FROM income_settings ORDER BY effective_from DESC, id").all<IncomeSettingRow>()).results;
  const events = (await db.prepare("SELECT * FROM income_events WHERE received_on >= ? ORDER BY received_on DESC, id DESC").bind(`${addMonths(month, -11)}-01`).all<IncomeEventRow>()).results;
  // Income-group transactions (not Salary) of the last 60 days that no income event is linked to yet
  const candidates = (await db.prepare(
    `SELECT t.id, t.occurred_at, t.merchant, t.category_id, t.amount_sgd_minor, t.currency, t.amount_minor
     FROM transactions t JOIN categories c ON c.id = t.category_id
     WHERE c.group_id = 'income' AND c.id != 'salary' AND t.status != 'void' AND t.occurred_at >= ?
       AND NOT EXISTS (SELECT 1 FROM income_events e WHERE e.transaction_id = t.id)
     ORDER BY t.occurred_at DESC, t.id DESC`,
  ).bind(dayRangeUtc(shiftDays(today, -60)).start).all()).results;
  return { base: await baseIncomeFor(db, month), history, events: events.map(eventView), candidates, split_rule: await loadSplitRule(db) };
}

income.get("/income", async (c) => c.json(await overview(c.env.DB, c.var.deps.now())));

const baseSchema = z.object({
  base_takehome_minor: z.number().int().min(0).max(MAX),
  effective_from: z.string().regex(monthRe).optional(),
});

income.put("/income/base", async (c) => {
  const p = baseSchema.safeParse(await body(c));
  if (!p.success) return c.json({ error: p.error.flatten() }, 400);
  const db = c.env.DB;
  const now = c.var.deps.now();
  const from = p.data.effective_from ?? sgtMonth(now);
  const existing = await db.prepare("SELECT id FROM income_settings WHERE effective_from = ?").bind(from).first<{ id: string }>();
  if (existing) await db.prepare("UPDATE income_settings SET base_takehome_minor = ? WHERE id = ?").bind(p.data.base_takehome_minor, existing.id).run();
  else await db.prepare("INSERT INTO income_settings (id, base_takehome_minor, currency, effective_from) VALUES (?,?,'SGD',?)").bind(ulid(now.getTime()), p.data.base_takehome_minor, from).run();
  return c.json(await overview(db, now));
});

const ruleSchema = z.object({
  goals_bp: z.number().int().min(0).max(10000),
  fun_bp: z.number().int().min(0).max(10000),
  buffer_bp: z.number().int().min(0).max(10000),
}).refine(validSplitRule, "the three shares must add up to 10000 (100%)");

income.put("/income/split-rule", async (c) => {
  const p = ruleSchema.safeParse(await body(c));
  if (!p.success) return c.json({ error: p.error.flatten() }, 400);
  await setSetting(c.env.DB, "commission_split", JSON.stringify(p.data));
  return c.json(p.data);
});

const eventSchema = z.object({
  kind: z.enum(["commission", "bonus", "other"]),
  amount_minor: z.number().int().min(1).max(MAX),
  received_on: isoDate.optional(),
  transaction_id: z.string().min(1).optional(),
});

income.post("/income/events", async (c) => {
  const p = eventSchema.safeParse(await body(c));
  if (!p.success) return c.json({ error: p.error.flatten() }, 400);
  const d = p.data;
  const db = c.env.DB;
  const now = c.var.deps.now();
  let receivedOn = d.received_on ?? sgtDate(now);
  if (d.transaction_id) {
    const txn = await db.prepare("SELECT occurred_at FROM transactions WHERE id = ?").bind(d.transaction_id).first<{ occurred_at: string }>();
    if (!txn) return c.json({ error: "unknown transaction" }, 400);
    if (await db.prepare("SELECT 1 AS x FROM income_events WHERE transaction_id = ?").bind(d.transaction_id).first()) return c.json({ error: "this transaction is already logged" }, 409);
    // a logged transaction is dated by when it arrived unless the caller says otherwise
    if (!d.received_on) receivedOn = sgtDate(txn.occurred_at);
  }
  let splitJson: string | null = null;
  let status: IncomeEventRow["split_status"] = "skipped";
  if (d.kind !== "other") {
    splitJson = JSON.stringify(commissionSplit(d.amount_minor, await loadSplitRule(db), await loadSplitGoals(db, now)));
    status = "proposed";
  }
  const id = ulid(now.getTime());
  try {
    await db.prepare("INSERT INTO income_events (id, kind, amount_minor, received_on, transaction_id, split_json, split_status) VALUES (?,?,?,?,?,?,?)")
      .bind(id, d.kind, d.amount_minor, receivedOn, d.transaction_id ?? null, splitJson, status).run();
  } catch {
    return c.json({ error: "this transaction is already logged" }, 409); // lost a race on the unique transaction_id
  }
  return c.json(eventView((await getEvent(db, id))!), 201);
});

/** Confirm a proposed split: pledges per goal (source 'commission'), the guilt-free share on this week's allowance. Only once. */
income.post("/income/events/:id/confirm", async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  const ev = await getEvent(db, id);
  if (!ev) return c.json({ error: "not found" }, 404);
  const claimed = await db.prepare("UPDATE income_events SET split_status = 'confirmed' WHERE id = ? AND split_status = 'proposed'").bind(id).run();
  if (!claimed.meta.changes) return c.json({ error: `already ${ev.split_status}` }, 409);
  const now = c.var.deps.now();
  const split = JSON.parse(ev.split_json ?? "null") as { pledges: { goal_id: string; amount: number }[]; bonus: number } | null;
  const period = ev.received_on.slice(0, 7);
  const stmts: D1PreparedStatement[] = [];
  const live = new Set((await db.prepare("SELECT id FROM goals WHERE archived = 0").all<{ id: string }>()).results.map((r) => r.id));
  for (const pl of split?.pledges ?? []) {
    if (pl.amount <= 0 || !live.has(pl.goal_id)) continue;
    stmts.push(db.prepare("INSERT INTO goal_contributions (id, goal_id, period, amount_sgd_minor, source, status, created_at) VALUES (?,?,?,?,'commission','pledged',?)").bind(ulid(now.getTime()), pl.goal_id, period, pl.amount, now.toISOString()));
  }
  if (split && split.bonus > 0) {
    const weekStart = sgtWeek(now, (await loadAllowanceSettings(db)).weekStart).startDate;
    stmts.push(db.prepare("INSERT INTO lifestyle_bonus (id, week_start, amount_sgd_minor, source, created_at) VALUES (?,?,?,?,?)").bind(ulid(now.getTime()), weekStart, split.bonus, `commission:${id}`, now.toISOString()));
  }
  if (stmts.length) await db.batch(stmts);
  return c.json(eventView((await getEvent(db, id))!));
});

income.post("/income/events/:id/skip", async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  const ev = await getEvent(db, id);
  if (!ev) return c.json({ error: "not found" }, 404);
  const r = await db.prepare("UPDATE income_events SET split_status = 'skipped' WHERE id = ? AND split_status = 'proposed'").bind(id).run();
  if (!r.meta.changes) return c.json({ error: `already ${ev.split_status}` }, 409);
  return c.json(eventView((await getEvent(db, id))!));
});

income.delete("/income/events/:id", async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  const ev = await getEvent(db, id);
  if (!ev) return c.json({ error: "not found" }, 404);
  const r = await db.prepare("DELETE FROM income_events WHERE id = ? AND split_status = 'proposed'").bind(id).run();
  if (!r.meta.changes) return c.json({ error: `already ${ev.split_status}` }, 409);
  return c.json({ id, deleted: true });
});
