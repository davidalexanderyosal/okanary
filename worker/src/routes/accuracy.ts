import { Hono } from "hono";
import { z } from "zod";
import { minorToDecimalString, sgtDate, sgtParts, tripTotals, toCsv, type SummaryRow } from "@okanary/core";
import { runAlertsInBackground } from "../alerts";
import { TXN_WITH_GROUP_SQL } from "../db";
import type { AppEnv } from "../env";
import { importStatement } from "../statement-import";
import { dayRangeUtc } from "@okanary/core";

export const accuracy = new Hono<AppEnv>();

// ---------- CSV export ----------
accuracy.get("/export/transactions.csv", async (c) => {
  const q = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).safeParse(c.req.query());
  if (!q.success) return c.json({ error: "bad date" }, 400);
  const where: string[] = [];
  const binds: string[] = [];
  if (q.data.from) { where.push("t.occurred_at >= ?"); binds.push(dayRangeUtc(q.data.from).start); }
  if (q.data.to) { where.push("t.occurred_at < ?"); binds.push(dayRangeUtc(q.data.to).end); }
  const { results } = await c.env.DB.prepare(
    `SELECT t.*, a.name AS account_name, c.name AS category_name, g.name AS group_name, tr.name AS trip_name
     FROM transactions t
     LEFT JOIN accounts a ON a.id = t.account_id LEFT JOIN categories c ON c.id = t.category_id
     LEFT JOIN category_groups g ON g.id = c.group_id LEFT JOIN trips tr ON tr.id = t.trip_id
     ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY t.occurred_at, t.id`,
  ).bind(...binds).all<Record<string, string | number | null>>();
  const head = ["id", "date_sgt", "time_sgt", "occurred_at_utc", "account", "merchant", "merchant_raw", "group", "category", "amount", "currency", "amount_sgd", "fx_rate", "fx_source", "status", "source", "refund", "reimbursable", "excluded", "trip", "note"];
  const rows = results.map((r) => {
    const p = sgtParts(String(r.occurred_at));
    const cur = String(r.currency);
    return [
      r.id, sgtDate(String(r.occurred_at)), `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`, r.occurred_at, r.account_name, r.merchant, r.merchant_raw, r.group_name, r.category_name,
      minorToDecimalString(Number(r.amount_minor), cur), cur, minorToDecimalString(Number(r.amount_sgd_minor), "SGD"), r.fx_rate, r.fx_source, r.status, r.source,
      r.is_refund ? "yes" : "", r.is_reimbursable ? "yes" : "", r.is_excluded ? "yes" : "", r.trip_name, r.note,
    ];
  });
  const stamp = sgtDate(c.var.deps.now());
  return new Response("﻿" + toCsv([head, ...rows]), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="okanary-transactions-${stamp}.csv"`, "cache-control": "no-store" },
  });
});

// ---------- statement import & reconcile ----------
accuracy.post("/import/statement", async (c) => {
  const p = z.object({ account_id: z.string().min(1), text: z.string().min(1).max(400_000), commit: z.boolean().default(false) }).safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ error: p.error.flatten() }, 400);
  const acct = await c.env.DB.prepare("SELECT id FROM accounts WHERE id = ?").bind(p.data.account_id).first();
  if (!acct) return c.json({ error: "unknown account" }, 400);
  try {
    const out = await importStatement(c.env, c.var.deps, p.data);
    if (p.data.commit) {
      let ctx: { waitUntil(p: Promise<unknown>): void } | undefined;
      try { ctx = c.executionCtx; } catch { /* tests */ }
      await runAlertsInBackground(c.env, c.var.deps, ctx);
    }
    // enrich ids with names for the preview
    const ids = [...out.plan.matched.map((m) => m.txnId), ...out.plan.notOnStatement];
    const names = new Map<string, { merchant: string | null; amount_sgd_minor: number; occurred_at: string }>();
    if (ids.length) {
      const ph = ids.map(() => "?").join(",");
      for (const t of (await c.env.DB.prepare(`SELECT id, merchant, amount_sgd_minor, occurred_at FROM transactions WHERE id IN (${ph})`).bind(...ids).all<{ id: string; merchant: string | null; amount_sgd_minor: number; occurred_at: string }>()).results) names.set(t.id, t);
    }
    return c.json({
      mode: out.parsed.mode, skipped: out.parsed.skipped.length, existing_in_window: out.existingInWindow, applied: out.applied ?? null,
      matched: out.plan.matched.map((m) => ({ date: m.row.date, description: m.row.description, billed: Math.abs(m.row.amount_minor), txn: names.get(m.txnId) ?? null, correct_sgd_to: m.correctSgdTo ?? null })),
      to_add: out.plan.toAdd.map((r) => ({ date: r.date, description: r.description, amount: r.amount_minor })),
      payments: out.plan.payments.map((r) => ({ date: r.date, description: r.description, amount: r.amount_minor })),
      not_on_statement: out.plan.notOnStatement.map((id) => ({ id, ...names.get(id) })),
    });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "import failed" }, 400);
  }
});

// ---------- trip totals ----------
accuracy.get("/trips/:id/summary", async (c) => {
  const trip = await c.env.DB.prepare("SELECT * FROM trips WHERE id = ?").bind(c.req.param("id")).first();
  if (!trip) return c.json({ error: "not found" }, 404);
  const rows = (await c.env.DB.prepare(`${TXN_WITH_GROUP_SQL} WHERE t.trip_id = ?`).bind(c.req.param("id")).all<SummaryRow>()).results;
  return c.json({ trip, ...tripTotals(rows) });
});
