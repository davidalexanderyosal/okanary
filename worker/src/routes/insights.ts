import { Hono } from "hono";
import { z } from "zod";
import { addMonths, billEstimate, cycleBounds, sgtDate, sgtMonth, sumSpend, summarizeMonth, type SummaryRow } from "@okanary/core";
import { TXN_WITH_GROUP_SQL, loadRowsBetween } from "../db";
import type { AppEnv } from "../env";
import { getSgdRate } from "../fx";
import { ulid } from "../util";
import { tripCovering } from "../trips";

export const insights = new Hono<AppEnv>();

/** Card-cycle view: spend on each card since its last statement, the bill it will become, and the due date (spec §7.5). */
insights.get("/cycles", async (c) => {
  const today = sgtDate(c.var.deps.now());
  const accts = (await c.env.DB.prepare("SELECT * FROM accounts WHERE archived = 0 AND kind = 'credit' ORDER BY name").all<{ id: string; name: string; bank: string | null; last4: string | null; statement_day: number | null; due_day: number | null }>()).results;
  const out = [];
  for (const a of accts) {
    if (!a.statement_day) { out.push({ account: a, configured: false }); continue; }
    const b = cycleBounds(a.statement_day, a.due_day, today);
    const rows = (await c.env.DB.prepare(`${TXN_WITH_GROUP_SQL} WHERE t.account_id = ? AND t.occurred_at >= ? AND t.occurred_at < ?`).bind(a.id, b.previous.start, b.current.end).all<SummaryRow>()).results;
    const inRange = (r: SummaryRow, x: { start: string; end: string }) => r.occurred_at >= x.start && r.occurred_at < x.end;
    const cur = rows.filter((r) => inRange(r, b.current));
    const prev = rows.filter((r) => inRange(r, b.previous));
    out.push({
      account: a, configured: true,
      last_statement: b.lastStatement, next_statement: b.nextStatement, cycle_start: b.cycleStart, due_date: b.dueDate,
      current_bill: billEstimate(cur), current_spend: sumSpend(cur), current_count: cur.length,
      previous_bill: billEstimate(prev), previous_count: prev.length,
    });
  }
  return c.json({ today, cycles: out });
});

/** Monthly totals for the last N months (Lifestyle trend, spec §7.5). */
insights.get("/trend", async (c) => {
  const q = z.object({ months: z.coerce.number().int().min(1).max(24).default(6), group: z.string().default("lifestyle") }).safeParse(c.req.query());
  if (!q.success) return c.json({ error: "bad query" }, 400);
  const now = c.var.deps.now();
  const last = sgtMonth(now);
  const first = addMonths(last, -(q.data.months - 1));
  const rows = await loadRowsBetween(c.env.DB, first, last);
  const points = [];
  for (let i = 0; i < q.data.months; i++) {
    const m = addMonths(first, i);
    const s = summarizeMonth(rows, m, now);
    points.push({ month: m, group: s.byGroup.find((g) => g.id === q.data.group)?.spent ?? 0, total: s.total });
  }
  return c.json({ group: q.data.group, points });
});

/** Rate for 1 unit of `currency` in SGD (cached ECB via Frankfurter). */
insights.get("/fx/:currency", async (c) => {
  const cur = c.req.param("currency").toUpperCase();
  if (!/^[A-Z]{3}$/.test(cur)) return c.json({ error: "bad currency" }, 400);
  const r = await getSgdRate(c.env.DB, cur, c.var.deps.now(), c.var.deps.fetch);
  return r ? c.json({ currency: cur, rate: r.rate, date: r.date }) : c.json({ error: "rate unavailable" }, 404);
});

// ---- trips (basic tagging; exclude-from-monthly arrives in Phase 5) ----
const tripSchema = z.object({
  name: z.string().min(1).max(80),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  currency: z.string().length(3).transform((s) => s.toUpperCase()).nullable().optional(),
  exclude_from_monthly: z.union([z.literal(0), z.literal(1), z.boolean()]).transform((v) => (v ? 1 : 0)).optional(),
});

insights.get("/trips", async (c) => c.json((await c.env.DB.prepare("SELECT * FROM trips ORDER BY start_date DESC, name").all()).results));
insights.get("/trips/active", async (c) => c.json(await tripCovering(c.env.DB, c.var.deps.now())));
insights.post("/trips", async (c) => {
  const p = tripSchema.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ error: p.error.flatten() }, 400);
  const d = p.data;
  if (d.start_date && d.end_date && d.end_date < d.start_date) return c.json({ error: "end before start" }, 400);
  const id = ulid();
  await c.env.DB.prepare("INSERT INTO trips (id, name, start_date, end_date, exclude_from_monthly, currency) VALUES (?,?,?,?,?,?)")
    .bind(id, d.name, d.start_date ?? null, d.end_date ?? null, d.exclude_from_monthly ?? 0, d.currency ?? null).run();
  return c.json(await c.env.DB.prepare("SELECT * FROM trips WHERE id = ?").bind(id).first(), 201);
});
insights.patch("/trips/:id", async (c) => {
  const p = tripSchema.partial().safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ error: p.error.flatten() }, 400);
  const cur = await c.env.DB.prepare("SELECT * FROM trips WHERE id = ?").bind(c.req.param("id")).first<Record<string, unknown>>();
  if (!cur) return c.json({ error: "not found" }, 404);
  const n = { ...cur, ...p.data };
  await c.env.DB.prepare("UPDATE trips SET name=?, start_date=?, end_date=?, exclude_from_monthly=?, currency=? WHERE id=?")
    .bind(n.name, n.start_date ?? null, n.end_date ?? null, n.exclude_from_monthly, n.currency ?? null, c.req.param("id")).run();
  return c.json(await c.env.DB.prepare("SELECT * FROM trips WHERE id = ?").bind(c.req.param("id")).first());
});
insights.delete("/trips/:id", async (c) => {
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE transactions SET trip_id = NULL WHERE trip_id = ?").bind(c.req.param("id")),
    c.env.DB.prepare("DELETE FROM trips WHERE id = ?").bind(c.req.param("id")),
  ]);
  return c.json({ ok: true });
});

