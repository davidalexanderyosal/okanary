import { Hono } from "hono";
import { z } from "zod";
import { normalizeMerchant } from "@okanary/core";
import type { AppEnv } from "../env";
import { REVIEW_WHERE, TXN_WITH_GROUP_SQL } from "../db";
import { ulid } from "../util";

export const review = new Hono<AppEnv>();

review.get("/review", async (c) => {
  const items = (await c.env.DB.prepare(`${TXN_WITH_GROUP_SQL} WHERE ${REVIEW_WHERE} ORDER BY t.occurred_at DESC LIMIT 200`).all()).results;
  const failed = (
    await c.env.DB.prepare("SELECT id, source, received_at, payload, error FROM raw_ingest WHERE parse_status = 'failed' AND transaction_id IS NULL ORDER BY received_at DESC LIMIT 50").all()
  ).results;
  return c.json({ items, failed });
});

review.post("/raw-ingest/:id/dismiss", async (c) => {
  const r = await c.env.DB.prepare("UPDATE raw_ingest SET parse_status = 'dismissed' WHERE id = ? AND parse_status = 'failed'").bind(c.req.param("id")).run();
  return r.meta.changes ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});

// ---- merchant rules ("Always use Transport for GRAB?") ----
const ruleSchema = z.object({
  match_type: z.enum(["exact", "prefix", "contains", "regex"]).default("exact"),
  pattern: z.string().min(1).max(200),
  category_id: z.string().nullable(),
  set_excluded: z.union([z.literal(0), z.literal(1), z.boolean()]).transform((v) => (v ? 1 : 0)).default(0),
  priority: z.number().int().min(0).max(1000).default(0),
});

review.get("/rules", async (c) =>
  c.json((await c.env.DB.prepare("SELECT r.*, c.name AS category_name FROM merchant_rules r LEFT JOIN categories c ON c.id = r.category_id ORDER BY r.priority DESC, r.pattern").all()).results),
);

review.post("/rules", async (c) => {
  const p = ruleSchema.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ error: p.error.flatten() }, 400);
  const d = p.data;
  if (d.match_type === "regex") {
    try { new RegExp(d.pattern); } catch { return c.json({ error: "invalid regex" }, 400); }
  }
  if (!d.category_id && !d.set_excluded) return c.json({ error: "rule needs a category or set_excluded" }, 400);
  const pattern = d.match_type === "regex" ? d.pattern : normalizeMerchant(d.pattern);
  // one rule per (type, pattern): updating the category is what "Always use X" means when changing your mind
  const existing = await c.env.DB.prepare("SELECT id FROM merchant_rules WHERE match_type = ? AND pattern = ?").bind(d.match_type, pattern).first<{ id: string }>();
  const id = existing?.id ?? ulid();
  if (existing) await c.env.DB.prepare("UPDATE merchant_rules SET category_id = ?, set_excluded = ?, priority = ? WHERE id = ?").bind(d.category_id, d.set_excluded, d.priority, id).run();
  else await c.env.DB.prepare("INSERT INTO merchant_rules (id, match_type, pattern, category_id, set_excluded, priority) VALUES (?,?,?,?,?,?)").bind(id, d.match_type, pattern, d.category_id, d.set_excluded, d.priority).run();
  return c.json(await c.env.DB.prepare("SELECT * FROM merchant_rules WHERE id = ?").bind(id).first(), existing ? 200 : 201);
});

review.delete("/rules/:id", async (c) => {
  const r = await c.env.DB.prepare("DELETE FROM merchant_rules WHERE id = ?").bind(c.req.param("id")).run();
  return r.meta.changes ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});
