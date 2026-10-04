import { Hono } from "hono";
import { z } from "zod";
import { resolveBudgets } from "@okanary/core";
import { loadBudgetRows } from "../alerts";
import { upsertBudget } from "../db";
import type { AppEnv } from "../env";
import { currentMonthSgt } from "../month";

export const budgets = new Hono<AppEnv>();
const monthRe = /^\d{4}-(0[1-9]|1[0-2])$/;

budgets.get("/budgets", async (c) => {
  const month = c.req.query("month") ?? currentMonthSgt(c.var.deps.now());
  if (!monthRe.test(month)) return c.json({ error: "bad month" }, 400);
  return c.json({ month, budgets: resolveBudgets(await loadBudgetRows(c.env.DB), month) });
});

const putSchema = z.object({
  scope: z.enum(["group", "category"]),
  ref_id: z.string().min(1),
  month: z.string().regex(monthRe),
  /** 0 clears the budget from this month on. */
  amount_sgd_minor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

budgets.put("/budgets", async (c) => {
  const p = putSchema.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ error: p.error.flatten() }, 400);
  const d = p.data;
  const exists = await c.env.DB.prepare(d.scope === "group" ? "SELECT 1 AS x FROM category_groups WHERE id = ?" : "SELECT 1 AS x FROM categories WHERE id = ?").bind(d.ref_id).first();
  if (!exists) return c.json({ error: `unknown ${d.scope}` }, 400);
  await upsertBudget(c.env.DB, d.scope, d.ref_id, d.month, d.amount_sgd_minor);
  return c.json({ month: d.month, budgets: resolveBudgets(await loadBudgetRows(c.env.DB), d.month) });
});

/** "Copy last month": writes explicit rows for `to` from whatever is in force in `from`. */
budgets.post("/budgets/copy", async (c) => {
  const p = z.object({ from: z.string().regex(monthRe), to: z.string().regex(monthRe) }).safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ error: p.error.flatten() }, 400);
  const src = resolveBudgets(await loadBudgetRows(c.env.DB), p.data.from);
  for (const b of src) await upsertBudget(c.env.DB, b.scope, b.ref_id, p.data.to, b.monthly_amount_sgd_minor);
  return c.json({ month: p.data.to, copied: src.length, budgets: resolveBudgets(await loadBudgetRows(c.env.DB), p.data.to) });
});
