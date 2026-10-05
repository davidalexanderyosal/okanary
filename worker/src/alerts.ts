import { DEFAULT_WEEKLY_THRESHOLDS, dayOfWeek, formatMoneyShort, monthProgress, parseThresholds, resolveBudgets, safeToSpendToday, sgtMonth, summarizeMonth, thresholdsReached, formatMoney } from "@okanary/core";
import type { Deps } from "./deps";
import { loadWeekAllowance } from "./allowance";
import { loadSummaryRows, loadBudgetRows } from "./db";
import type { Env } from "./env";
import { sendNudge } from "./nudge-gate";
import { getSetting } from "./settings";
import { nowIso, ulid } from "./util";

export { loadBudgetRows };

/**
 * Threshold alerts (spec §3.1, §7): at 50 / 80 / 100 % (configurable) of any budget, once per budget per month.
 * `alert_log (kind='budget', ref='group:lifestyle', period='2026-10:80')` + a unique index make "once" race-free.
 * If one purchase jumps over several thresholds, all of them are logged but only the highest sends a push.
 * Only the CURRENT SGT month is evaluated (editing an old transaction must not alert).
 */
export async function checkBudgetAlerts(env: Env, deps: Deps): Promise<{ ref: string; threshold: number }[]> {
  const month = sgtMonth(deps.now());
  const budgets = resolveBudgets(await loadBudgetRows(env.DB), month);
  if (budgets.length === 0) return [];
  const thresholds = parseThresholds(await getSetting(env.DB, "alert_thresholds"));
  const summary = summarizeMonth(await loadSummaryRows(env.DB, month), month, deps.now());
  const prog = monthProgress(deps.now());
  const fired: { ref: string; threshold: number }[] = [];

  for (const b of budgets) {
    const bucket = (b.scope === "group" ? summary.byGroup : summary.byCategory).find((x) => x.id === b.ref_id);
    const spent = bucket?.spent ?? 0;
    const reached = thresholdsReached(spent, b.monthly_amount_sgd_minor, thresholds);
    if (reached.length === 0) continue;
    const ref = `${b.scope}:${b.ref_id}`;
    const newly: number[] = [];
    for (const t of reached) {
      const r = await env.DB.prepare("INSERT OR IGNORE INTO alert_log (id, kind, ref, period, sent_at) VALUES (?,?,?,?,?)").bind(ulid(), "budget", ref, `${month}:${t}`, nowIso()).run();
      if (r.meta.changes) newly.push(t);
    }
    if (newly.length === 0) continue;
    const top = Math.max(...newly);
    fired.push({ ref, threshold: top });

    const name = (await env.DB.prepare(b.scope === "group" ? "SELECT name FROM category_groups WHERE id = ?" : "SELECT name FROM categories WHERE id = ?").bind(b.ref_id).first<{ name: string }>())?.name ?? b.ref_id;
    const safe = safeToSpendToday(b.monthly_amount_sgd_minor, spent, prog.daysLeft);
    const f = (n: number) => formatMoney(n, "SGD", { compact: true });
    const body = safe.exceeded
      ? `${name} is over budget: ${f(spent)} of ${f(b.monthly_amount_sgd_minor)} (day ${prog.day}/${prog.daysInMonth}).`
      : `${name} at ${top}%: ${f(spent)} of ${f(b.monthly_amount_sgd_minor)} (day ${prog.day}/${prog.daysInMonth}). Safe to spend: ${f(safe.perDay)}/day.`;
    await sendNudge(env, deps, { title: "Okanary", body, url: "/budgets", tag: `budget-${b.scope}-${b.ref_id}` }, "budget");
  }
  return fired;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Weekly Lifestyle allowance alerts (v2 A): 80% and 100% of this week's allowance, once per week each.
 * `alert_log (kind='weekly_allowance', ref=threshold, period='YYYY-Www')`; several newly reached thresholds are all logged,
 * only the highest pushes. Nothing when there is no allowance.
 */
export async function checkWeeklyAllowanceAlerts(env: Env, deps: Deps): Promise<{ threshold: number }[]> {
  const { week, allowance, spent } = await loadWeekAllowance(env.DB, deps.now());
  if (!allowance.hasAllowance || allowance.total <= 0) return [];
  const reached = thresholdsReached(spent, allowance.total, DEFAULT_WEEKLY_THRESHOLDS);
  if (reached.length === 0) return [];
  const newly: number[] = [];
  for (const t of reached) {
    const r = await env.DB.prepare("INSERT OR IGNORE INTO alert_log (id, kind, ref, period, sent_at) VALUES (?,?,?,?,?)").bind(ulid(), "weekly_allowance", String(t), week.label, deps.now().toISOString()).run();
    if (r.meta.changes) newly.push(t);
  }
  if (newly.length === 0) return [];
  const top = Math.max(...newly);
  const f = (n: number) => formatMoneyShort(n, "SGD");
  const nextDay = DAY_NAMES[(dayOfWeek(week.endDate) + 1) % 7]!;
  const body = top >= 100
    ? `Lifestyle this week: ${f(spent)} of ${f(allowance.total)} used. A fresh week starts ${nextDay}.`
    : `Lifestyle this week: ${top}% used, ${f(allowance.total - spent)} left of ${f(allowance.total)}. Resets ${nextDay}.`;
  await sendNudge(env, deps, { title: "Okanary", body, url: "/", tag: "weekly-allowance" }, "weekly_allowance");
  return [{ threshold: top }];
}

/** Fire-and-forget wrapper used after any transaction write. Never throws. */
export function runAlertsInBackground(env: Env, deps: Deps, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<unknown> | void {
  const p = (async () => {
    await checkBudgetAlerts(env, deps).catch(() => undefined);
    await checkWeeklyAllowanceAlerts(env, deps).catch(() => undefined);
  })();
  if (ctx) ctx.waitUntil(p);
  else return p;
}
