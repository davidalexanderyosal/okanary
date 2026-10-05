import {
  carryChainStarts, carryIn, isSpend, monthRangeUtc, parseWeekStart, resolveBudgets, sgtMonth, sgtWeek, signedSgdMinor, weekAllowance, weekOf, weekSafeToSpend,
  type BudgetRow, type SgtWeek, type SummaryRow, type WeekAllowance, type WeekSafeToSpend,
} from "@okanary/core";
import { TXN_WITH_GROUP_SQL, loadBudgetRows } from "./db";
import { getSetting } from "./settings";

export interface WeekAllowanceState {
  week: SgtWeek;
  allowance: WeekAllowance;
  /** Lifestyle spend this week, SGD minor (spend definition; trip-excluded rows drop out) */
  spent: number;
  safe: WeekSafeToSpend;
  weekStart: number;
  carryEnabled: boolean;
  overrideMinor: number | null;
}

export interface AllowanceSettings { weekStart: number; overrideMinor: number | null; carryEnabled: boolean }

export async function loadAllowanceSettings(db: D1Database): Promise<AllowanceSettings> {
  const [ws, ov, carry] = await Promise.all([getSetting(db, "week_start"), getSetting(db, "allowance_override_minor"), getSetting(db, "allowance_carry")]);
  const n = Number(ov);
  return { weekStart: parseWeekStart(ws), overrideMinor: ov != null && ov !== "" && Number.isSafeInteger(n) && n > 0 ? n : null, carryEnabled: carry === "1" };
}

/** Lifestyle group budget in force for `month` ('YYYY-MM'), or null. */
export function lifestyleBudgetFor(rows: BudgetRow[], month: string): number | null {
  return resolveBudgets(rows, month).find((b) => b.scope === "group" && b.ref_id === "lifestyle")?.monthly_amount_sgd_minor ?? null;
}

export async function loadRowsInRange(db: D1Database, start: string, end: string): Promise<SummaryRow[]> {
  return (await db.prepare(`${TXN_WITH_GROUP_SQL} WHERE t.occurred_at >= ?1 AND t.occurred_at < ?2`).bind(start, end).all<SummaryRow>()).results;
}

/** Lifestyle spend (spend definition, SGD minor) over [start, end) UTC ISO, from already-loaded rows. */
export function lifestyleSpend(rows: SummaryRow[], start: string, end: string): number {
  let sum = 0;
  for (const r of rows) if (r.occurred_at >= start && r.occurred_at < end && isSpend(r) && r.group_id === "lifestyle") sum += signedSgdMinor(r);
  return sum;
}

export interface LoadOptions {
  /** One-off additions to a week's allowance, keyed by the week's start date. Overrides the lifestyle_bonus table when given. */
  bonusForWeek?: (startDate: string) => number;
}

/** Σ lifestyle_bonus per week start date for weeks starting in [from, to] (feature P: the commission split's guilt-free share). */
export async function loadBonusByWeek(db: D1Database, from: string, to: string): Promise<Map<string, number>> {
  const rows = (await db.prepare("SELECT week_start, SUM(amount_sgd_minor) AS n FROM lifestyle_bonus WHERE week_start >= ?1 AND week_start <= ?2 GROUP BY week_start").bind(from, to).all<{ week_start: string; n: number }>()).results;
  return new Map(rows.map((r) => [r.week_start, r.n]));
}

export async function loadWeekAllowance(db: D1Database, now: Date, opts: LoadOptions = {}): Promise<WeekAllowanceState> {
  const settings = await loadAllowanceSettings(db);
  const budgets = await loadBudgetRows(db);
  const budgetForMonth = (month: string) => lifestyleBudgetFor(budgets, month);
  const week = sgtWeek(now, settings.weekStart);
  const chain = settings.carryEnabled ? carryChainStarts(week.startDate) : [];
  // preload the bonuses of the current week and the carry chain, then hand weekAllowance a sync lookup
  const bonuses = opts.bonusForWeek ? null : await loadBonusByWeek(db, chain[0] ?? week.startDate, week.startDate);
  const bonusForWeek = opts.bonusForWeek ?? ((startDate: string) => bonuses?.get(startDate) ?? 0);

  const from = chain.length ? weekOf(chain[0]!).start : week.start;
  const rows = await loadRowsInRange(db, from, week.end);
  const spent = lifestyleSpend(rows, week.start, week.end);

  let carry = 0;
  if (chain.length) {
    const prior = chain.map((startDate) => {
      const w = weekOf(startDate);
      const a = weekAllowance({ startDate, budgetForMonth, overrideMinor: settings.overrideMinor, bonus: bonusForWeek(startDate) });
      return { startDate, allowance: a.total, spent: lifestyleSpend(rows, w.start, w.end) };
    });
    carry = carryIn(week.startDate, prior);
  }
  const allowance = weekAllowance({ startDate: week.startDate, budgetForMonth, overrideMinor: settings.overrideMinor, carry, bonus: bonusForWeek(week.startDate) });
  return { week, allowance, spent, safe: weekSafeToSpend(allowance.total, spent, week.daysLeft), weekStart: settings.weekStart, carryEnabled: settings.carryEnabled, overrideMinor: settings.overrideMinor };
}

/** Month-to-date Lifestyle figures for the card's smaller second line. */
export async function loadLifestyleMonth(db: D1Database, now: Date): Promise<{ budget: number | null; spent: number }> {
  const month = sgtMonth(now);
  const r = monthRangeUtc(month);
  const budget = lifestyleBudgetFor(await loadBudgetRows(db), month);
  return { budget, spent: lifestyleSpend(await loadRowsInRange(db, r.start, r.end), r.start, r.end) };
}

