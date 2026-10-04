import { daysInMonth, shiftWeek, weekOf } from "./dates";

/**
 * Weekly Lifestyle allowance (v2 feature A). Pure integer maths; every boundary is an SGT calendar date.
 *
 * allowance(week ∩ month) = monthly_budget × days_of_week_in_this_month ÷ days_in_month, per month, summed.
 * Rounding (D-47): each part is the difference of two rounded cumulative amounts,
 *   part(days a..b of month) = R(budget·b/dim) − R(budget·(a−1)/dim),   R = round half up,
 * so every part is within one minor unit of the exact pro-rata value AND the parts of all weeks touching a month add up
 * to exactly that month's budget.
 */

export interface AllowancePart {
  month: string; // 'YYYY-MM'
  /** first/last day-of-month of the week's days that fall in this month (inclusive) */
  fromDay: number;
  toDay: number;
  days: number;
  daysInMonth: number;
  budget: number;
  amount: number;
}

/** Round half up of a non-negative rational n/d (both integers). */
function roundDiv(n: number, d: number): number {
  if (d <= 0) throw new Error("division by zero");
  const bn = BigInt(n) * 2n + BigInt(d);
  return Number(bn / (2n * BigInt(d)));
}

/** Pro-rata share of a month's budget for days fromDay..toDay (1-based, inclusive). */
export function proratePart(budget: number, fromDay: number, toDay: number, dim: number): number {
  if (!Number.isSafeInteger(budget) || budget < 0) throw new Error(`budget must be a non-negative integer, got ${budget}`);
  if (fromDay < 1 || toDay > dim || fromDay > toDay) throw new Error(`bad day range ${fromDay}..${toDay} of ${dim}`);
  return roundDiv(budget * toDay, dim) - roundDiv(budget * (fromDay - 1), dim);
}

/** Split the 7 days starting `startDate` into per-month parts and prorate each month's budget. */
export function allowanceParts(startDate: string, budgetForMonth: (month: string) => number | null | undefined): AllowancePart[] {
  const w = weekOf(startDate);
  const parts: AllowancePart[] = [];
  const first = { month: w.startDate.slice(0, 7), day: +w.startDate.slice(8, 10) };
  const last = { month: w.endDate.slice(0, 7), day: +w.endDate.slice(8, 10) };
  const months = first.month === last.month ? [first.month] : [first.month, last.month];
  for (const month of months) {
    const dim = daysInMonth(month);
    const fromDay = month === first.month ? first.day : 1;
    const toDay = month === last.month ? last.day : dim;
    const budget = Math.max(0, budgetForMonth(month) ?? 0);
    parts.push({ month, fromDay, toDay, days: toDay - fromDay + 1, daysInMonth: dim, budget, amount: proratePart(budget, fromDay, toDay, dim) });
  }
  return parts;
}

export interface WeekAllowance {
  startDate: string;
  endDate: string;
  /** pro-rata value from the monthly budget(s) */
  derived: number;
  /** derived, or the manual weekly override when set */
  base: number;
  overridden: boolean;
  /** carried in from earlier weeks of the same month (0 when the setting is off); can be negative */
  carry: number;
  /** one-off additions for this week (e.g. P's guilt-free commission share) */
  bonus: number;
  /** base + carry + bonus */
  total: number;
  /** false when there is neither a Lifestyle budget nor an override: no allowance to show */
  hasAllowance: boolean;
  parts: AllowancePart[];
}

export interface WeekAllowanceInput {
  startDate: string;
  budgetForMonth: (month: string) => number | null | undefined;
  /** fixed weekly amount from Settings; replaces the derived value when set (> 0) */
  overrideMinor?: number | null;
  carry?: number;
  bonus?: number;
}

export function weekAllowance(i: WeekAllowanceInput): WeekAllowance {
  const parts = allowanceParts(i.startDate, i.budgetForMonth);
  const derived = parts.reduce((a, p) => a + p.amount, 0);
  const overridden = i.overrideMinor != null && i.overrideMinor > 0;
  const base = overridden ? i.overrideMinor! : derived;
  const carry = i.carry ?? 0;
  const bonus = i.bonus ?? 0;
  const hasAllowance = overridden || parts.some((p) => p.budget > 0);
  const w = weekOf(i.startDate);
  return { startDate: w.startDate, endDate: w.endDate, derived, base, overridden, carry, bonus, total: base + carry + bonus, hasAllowance, parts };
}

/**
 * Carry-over (setting, default off). Unspent (or overspent) allowance rolls into the next week only within one month:
 * the chain runs over consecutive weeks that START in the same calendar month (D-48), so the first week starting in a
 * month never inherits. `prior` = the earlier weeks of this chain (any order), each with its own allowance excluding carry.
 * Telescoping: carry_k = Σ (allowance_i − spent_i) over the prior weeks.
 */
export function carryIn(startDate: string, prior: { startDate: string; allowance: number; spent: number }[]): number {
  const month = startDate.slice(0, 7);
  let c = 0;
  for (const w of prior) {
    if (w.startDate.slice(0, 7) !== month || w.startDate >= startDate) continue;
    c += w.allowance - w.spent;
  }
  return c;
}

/** Start dates of the earlier weeks in this week's carry chain (same start month, before this week), oldest first. */
export function carryChainStarts(startDate: string): string[] {
  const out: string[] = [];
  let d = weekOf(startDate).startDate;
  for (;;) {
    const prev = shiftWeek(d, -1);
    if (prev.slice(0, 7) !== startDate.slice(0, 7)) break;
    out.unshift(prev);
    d = prev;
  }
  return out;
}

export interface WeekSafeToSpend {
  /** (allowance − spent) ÷ days left in the week including today, floored at 0 */
  perDay: number;
  /** allowance − spent (negative when over) */
  left: number;
  daysLeft: number;
  over: boolean;
}

export function weekSafeToSpend(allowance: number, spent: number, daysLeftInWeek: number): WeekSafeToSpend {
  const left = allowance - spent;
  const dl = Math.min(Math.max(daysLeftInWeek, 1), 7);
  return { perDay: left > 0 ? Math.floor(left / dl) : 0, left, daysLeft: dl, over: left < 0 };
}

export const DEFAULT_WEEKLY_THRESHOLDS = [80, 100];
