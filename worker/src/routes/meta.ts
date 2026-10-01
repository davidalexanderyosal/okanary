import { Hono } from "hono";
import { z } from "zod";
import { currentMonthSgt } from "../month";
import type { AppEnv } from "../env";
import { monthSummary } from "../db";
import { nowIso, ulid } from "../util";

export const meta = new Hono<AppEnv>();

meta.get("/health", async (c) => {
  const row = await c.env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
  return c.json({ ok: row?.ok === 1, name: "okanary", time: nowIso() });
});

meta.get("/summary", async (c) => {
  const month = c.req.query("month") ?? currentMonthSgt(c.var.deps.now());
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return c.json({ error: "bad month" }, 400);
  return c.json(await monthSummary(c.env.DB, month, c.var.deps.now()));
});

// ---- reference data ----
meta.get("/categories", async (c) => {
  const groups = (await c.env.DB.prepare("SELECT * FROM category_groups ORDER BY sort").all()).results;
  const categories = (await c.env.DB.prepare("SELECT * FROM categories ORDER BY sort, name").all()).results;
  // Usage over the last ~120 days orders Quick-add chips "most used first".
  const since = new Date(Date.now() - 120 * 86400_000).toISOString();
  const rows = (await c.env.DB.prepare("SELECT category_id, COUNT(*) AS n FROM transactions WHERE category_id IS NOT NULL AND occurred_at >= ? GROUP BY category_id").bind(since).all<{ category_id: string; n: number }>()).results;
  const usage = Object.fromEntries(rows.map((r) => [r.category_id, r.n]));
  return c.json({ groups, categories, usage });
});

const catSchema = z.object({
  group_id: z.string(), name: z.string().min(1).max(60),
  icon: z.string().max(8).nullable().optional(), color: z.string().max(20).nullable().optional(),
});
meta.post("/categories", async (c) => {
  const p = catSchema.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ error: p.error.flatten() }, 400);
  const id = ulid();
  await c.env.DB.prepare("INSERT INTO categories (id, group_id, name, icon, color, sort) VALUES (?,?,?,?,?, (SELECT COALESCE(MAX(sort),0)+1 FROM categories WHERE group_id = ?))")
    .bind(id, p.data.group_id, p.data.name, p.data.icon ?? null, p.data.color ?? null, p.data.group_id).run();
  return c.json(await c.env.DB.prepare("SELECT * FROM categories WHERE id=?").bind(id).first(), 201);
});
meta.patch("/categories/:id", async (c) => {
  const p = catSchema.partial().extend({ archived: z.union([z.literal(0), z.literal(1)]).optional() }).safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ error: p.error.flatten() }, 400);
  const cur = await c.env.DB.prepare("SELECT * FROM categories WHERE id=?").bind(c.req.param("id")).first<Record<string, unknown>>();
  if (!cur) return c.json({ error: "not found" }, 404);
  const n = { ...cur, ...p.data };
  await c.env.DB.prepare("UPDATE categories SET group_id=?, name=?, icon=?, color=?, archived=? WHERE id=?")
    .bind(n.group_id, n.name, n.icon ?? null, n.color ?? null, n.archived, c.req.param("id")).run();
  return c.json(await c.env.DB.prepare("SELECT * FROM categories WHERE id=?").bind(c.req.param("id")).first());
});

const groupPatch = z.object({ name: z.string().min(1).max(60).optional(), counts_as_spend: z.union([z.literal(0), z.literal(1)]).optional() });
meta.patch("/groups/:id", async (c) => {
  const p = groupPatch.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ error: p.error.flatten() }, 400);
  const cur = await c.env.DB.prepare("SELECT * FROM category_groups WHERE id=?").bind(c.req.param("id")).first<Record<string, unknown>>();
  if (!cur) return c.json({ error: "not found" }, 404);
  const n = { ...cur, ...p.data };
  await c.env.DB.prepare("UPDATE category_groups SET name=?, counts_as_spend=? WHERE id=?").bind(n.name, n.counts_as_spend, c.req.param("id")).run();
  return c.json(n);
});

// ---- accounts ----
const acctSchema = z.object({
  name: z.string().min(1).max(60),
  kind: z.enum(["credit", "debit", "cash", "ewallet"]),
  bank: z.string().max(40).nullable().optional(),
  last4: z.string().regex(/^\d{4}$/).nullable().optional(),
  wallet_card_name: z.string().max(80).nullable().optional(),
  statement_day: z.number().int().min(1).max(31).nullable().optional(),
  due_day: z.number().int().min(1).max(31).nullable().optional(),
  currency: z.string().length(3).default("SGD"),
});
meta.get("/accounts", async (c) => c.json((await c.env.DB.prepare("SELECT * FROM accounts WHERE archived = 0 ORDER BY name").all()).results));
meta.post("/accounts", async (c) => {
  const p = acctSchema.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ error: p.error.flatten() }, 400);
  const d = p.data;
  const id = ulid();
  await c.env.DB.prepare("INSERT INTO accounts (id,name,kind,bank,last4,wallet_card_name,statement_day,due_day,currency) VALUES (?,?,?,?,?,?,?,?,?)")
    .bind(id, d.name, d.kind, d.bank ?? null, d.last4 ?? null, d.wallet_card_name ?? null, d.statement_day ?? null, d.due_day ?? null, d.currency.toUpperCase()).run();
  return c.json(await c.env.DB.prepare("SELECT * FROM accounts WHERE id=?").bind(id).first(), 201);
});
meta.patch("/accounts/:id", async (c) => {
  const p = acctSchema.partial().extend({ archived: z.union([z.literal(0), z.literal(1)]).optional() }).safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ error: p.error.flatten() }, 400);
  const cur = await c.env.DB.prepare("SELECT * FROM accounts WHERE id=?").bind(c.req.param("id")).first<Record<string, unknown>>();
  if (!cur) return c.json({ error: "not found" }, 404);
  const n = { ...cur, ...p.data };
  await c.env.DB.prepare("UPDATE accounts SET name=?,kind=?,bank=?,last4=?,wallet_card_name=?,statement_day=?,due_day=?,currency=?,archived=? WHERE id=?")
    .bind(n.name, n.kind, n.bank ?? null, n.last4 ?? null, n.wallet_card_name ?? null, n.statement_day ?? null, n.due_day ?? null, n.currency, n.archived, c.req.param("id")).run();
  return c.json(await c.env.DB.prepare("SELECT * FROM accounts WHERE id=?").bind(c.req.param("id")).first());
});
