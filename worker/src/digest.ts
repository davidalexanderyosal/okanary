import { expectedByDay, isSpend, monthProgress, prettyMerchant, sgtDate, sgtMonth, sgtWeekRangeUtc, signedSgdMinor, summarizeMonth, weeklyDigestBody } from "@okanary/core";
import { lifestyleBudget } from "./capture";
import { loadSummaryRows } from "./db";
import type { Deps } from "./deps";
import type { Env } from "./env";
import { sendNudge } from "./nudge-gate";
import { getSetting } from "./settings";
import { nowIso, ulid } from "./util";

/** Sunday 20:00 SGT push (spec §3.2): week total, Lifestyle vs pace, biggest 3 purchases. Once per week (alert_log). */
export async function sendWeeklyDigest(env: Env, deps: Deps): Promise<{ sent: boolean; body?: string }> {
  if ((await getSetting(env.DB, "push_weekly_digest")) === "0") return { sent: false };
  const now = deps.now();
  const week = sgtWeekRangeUtc(now);
  const claimed = await env.DB.prepare("INSERT OR IGNORE INTO alert_log (id, kind, ref, period, sent_at) VALUES (?,?,?,?,?)").bind(ulid(), "weekly_digest", "all", sgtDate(week.start), nowIso()).run();
  if (!claimed.meta.changes) return { sent: false };

  const month = sgtMonth(now);
  const rows = await loadSummaryRows(env.DB, month);
  const weekRows = rows.filter((r) => r.occurred_at >= week.start && r.occurred_at < week.end && isSpend(r));
  const weekTotal = weekRows.reduce((a, r) => a + signedSgdMinor(r), 0);
  const top = weekRows.filter((r) => !r.is_refund).sort((a, b) => b.amount_sgd_minor - a.amount_sgd_minor).slice(0, 3).map((r) => ({ merchant: prettyMerchant(r.merchant) || "Expense", amountSgd: r.amount_sgd_minor }));
  const s = summarizeMonth(rows, month, now);
  const prog = monthProgress(now);
  const budget = await lifestyleBudget(env.DB, month);
  const body = weeklyDigestBody({
    weekTotalSgd: weekTotal, lifestyleSpentSgd: s.byGroup.find((g) => g.id === "lifestyle")?.spent ?? 0,
    lifestyleBudgetSgd: budget, lifestyleExpectedSgd: budget ? expectedByDay(budget, prog.day, prog.daysInMonth) : null, top,
  });
  await sendNudge(env, deps, { title: "Okanary: your week", body, url: "/reports", tag: "weekly-digest" }, "weekly_digest");
  return { sent: true, body };
}
