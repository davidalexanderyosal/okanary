import { Hono } from "hono";
import { z } from "zod";
import { sgtMonth } from "@okanary/core";
import type { AppEnv } from "../env";
import { acceptPlan, monthRe, planPayload } from "../plan";
import { deleteSetting, getSetting, setSetting } from "../settings";

export const plan = new Hono<AppEnv>();

plan.get("/plan", async (c) => {
  const now = c.var.deps.now();
  const month = c.req.query("month") ?? sgtMonth(now);
  if (!monthRe.test(month)) return c.json({ error: "bad month" }, 400);
  return c.json(await planPayload(c.env.DB, now, month));
});

/** Accept: store the plan, write the month's Lifestyle budget (A's weekly allowance follows) and every goal's planned monthly. */
plan.post("/plan/accept", async (c) => {
  const p = z.object({ month: z.string().regex(monthRe).optional(), extend: z.boolean().optional() }).safeParse(await c.req.json().catch(() => ({})));
  if (!p.success) return c.json({ error: p.error.flatten() }, 400);
  const now = c.var.deps.now();
  const month = p.data.month ?? sgtMonth(now);
  if (!(await acceptPlan(c.env.DB, now, month, !!p.data.extend))) return c.json({ error: "set your base take-home income first", needs_income: true, month }, 409);
  return c.json(await planPayload(c.env.DB, now, month));
});

const settingsSchema = z.object({
  overrides: z.record(z.string().min(1).max(64), z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)).nullable().optional(),
  lifestyle_floor_minor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
});

plan.put("/plan/settings", async (c) => {
  const p = settingsSchema.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ error: p.error.flatten() }, 400);
  const db = c.env.DB;
  if (p.data.overrides !== undefined) {
    if (p.data.overrides && Object.keys(p.data.overrides).length) await setSetting(db, "plan_overrides", JSON.stringify(p.data.overrides));
    else await deleteSetting(db, "plan_overrides");
  }
  if (p.data.lifestyle_floor_minor !== undefined) {
    if (p.data.lifestyle_floor_minor !== null) await setSetting(db, "plan_lifestyle_floor_minor", String(p.data.lifestyle_floor_minor));
    else await deleteSetting(db, "plan_lifestyle_floor_minor");
  }
  const [ov, fl] = await Promise.all([getSetting(db, "plan_overrides"), getSetting(db, "plan_lifestyle_floor_minor")]);
  return c.json({ overrides: ov ? JSON.parse(ov) : {}, lifestyle_floor_minor: fl != null ? Number(fl) : null });
});
