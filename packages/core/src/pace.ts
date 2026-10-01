/** Pace / safe-to-spend / threshold maths (spec §3.1, §7). Integer minor units only. */

/** What you "should" have spent by the end of `day` if spending were even across the month. */
export function expectedByDay(budget: number, day: number, daysInMonth: number): number {
  if (daysInMonth <= 0) return 0;
  return Math.floor((budget * Math.min(Math.max(day, 0), daysInMonth)) / daysInMonth);
}

export type PaceState = "under" | "on" | "over" | "exceeded";

export interface Pace {
  budget: number;
  spent: number;
  expected: number;
  /** spent - expected: positive = ahead of pace (overspending). */
  delta: number;
  /** integer percentages of budget */
  pctSpent: number;
  pctExpected: number;
  /** under: >5% of budget below pace; on: within ±5%; over: ahead of pace; exceeded: spent > budget */
  state: PaceState;
}

export function paceFor(spent: number, budget: number, day: number, daysInMonth: number): Pace {
  const expected = expectedByDay(budget, day, daysInMonth);
  const delta = spent - expected;
  const tol = Math.floor(budget / 20); // 5% of budget
  const state: PaceState = spent > budget ? "exceeded" : delta > tol ? "over" : delta < -tol ? "under" : "on";
  return {
    budget, spent, expected, delta, state,
    pctSpent: budget > 0 ? Math.round((spent * 100) / budget) : 0,
    pctExpected: budget > 0 ? Math.round((expected * 100) / budget) : 0,
  };
}

export interface SafeToSpend {
  /** Per-day amount you can spend from today to month end and still land on budget; never negative. */
  perDay: number;
  /** Remaining budget (negative once exceeded). */
  remaining: number;
  daysLeft: number;
  exceeded: boolean;
}

/** (budget − spent) ÷ days left, where days left includes today. */
export function safeToSpendToday(budget: number, spent: number, daysLeft: number): SafeToSpend {
  const remaining = budget - spent;
  const dl = Math.max(daysLeft, 1);
  return { perDay: remaining > 0 ? Math.floor(remaining / dl) : 0, remaining, daysLeft: dl, exceeded: remaining < 0 };
}

/** Which of `thresholds` (percent of budget) the spend has reached. Exact integer comparison, no rounding. */
export function thresholdsReached(spent: number, budget: number, thresholds: number[]): number[] {
  if (budget <= 0) return [];
  return thresholds.filter((t) => spent * 100 >= t * budget).sort((a, b) => a - b);
}

export const DEFAULT_THRESHOLDS = [50, 80, 100];

export function parseThresholds(csv: string | null | undefined): number[] {
  const out = (csv ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 200);
  return out.length ? [...new Set(out)].sort((a, b) => a - b) : DEFAULT_THRESHOLDS;
}

/** Budget rows resolve per (scope, ref): the latest row whose effective_from <= month wins; amount 0 means "no budget". */
export interface BudgetRow { scope: "group" | "category"; ref_id: string; monthly_amount_sgd_minor: number; effective_from: string }
export function resolveBudgets(rows: BudgetRow[], month: string): BudgetRow[] {
  const best = new Map<string, BudgetRow>();
  for (const r of rows) {
    if (r.effective_from > month) continue;
    const k = `${r.scope}:${r.ref_id}`;
    const cur = best.get(k);
    if (!cur || r.effective_from > cur.effective_from) best.set(k, r);
  }
  return [...best.values()].filter((r) => r.monthly_amount_sgd_minor > 0);
}
