import { Hono } from "hono";
import { loadLifestyleMonth, loadWeekAllowance } from "../allowance";
import type { AppEnv } from "../env";

export const allowance = new Hono<AppEnv>();

allowance.get("/allowance", async (c) => {
  const now = c.var.deps.now();
  const s = await loadWeekAllowance(c.env.DB, now);
  const { week } = s;
  return c.json({
    week: { startDate: week.startDate, endDate: week.endDate, day: week.day, daysLeft: week.daysLeft, label: week.label },
    allowance: s.allowance,
    spent: s.spent,
    safe: s.safe,
    week_start: s.weekStart,
    carry: s.carryEnabled,
    override_minor: s.overrideMinor,
    month: await loadLifestyleMonth(c.env.DB, now),
  });
});
