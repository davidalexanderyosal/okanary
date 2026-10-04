import { addMonths, dayRangeUtc, daysInMonth, monthRangeUtc, sgtDate, sgtMonth, sgtParts, sgtWeek, shiftWeek, weekOf } from "./dates";
import { formatMoneyShort } from "./money";
import { isSpend, signedSgdMinor, type SpendRow } from "./spend";

/**
 * "Vs your usual" (v2 feature U). Compares spend so far in the current period with the average spend by the same point
 * in recent complete periods. Everything goes through the spend definition, so excluded trips (trip_excluded) are left out
 * of both the current period and the baseline automatically.
 *
 * Month: day-of-month d → spend over days 1..min(d, month_length) in each of the last 3 complete months that have data.
 * Week:  k days into the week (incl. today) → spend over the first k days of each of the last 4 complete weeks that have data.
 * "Has data" = the period contains at least one row that counts as spend (any category), so a category that was simply not
 * bought in a month still averages in a 0 for that month.
 */

export interface UsualRow extends SpendRow {
  occurred_at: string;
  category_id: string | null;
  group_id: string | null;
}

export type UsualState = "about" | "above" | "below" | "no_history";

export interface Comparison {
  state: UsualState;
  /** current − usual, SGD minor (null without history) */
  diff: number | null;
  /** rounded percentage of usual (null without history or when usual is 0) */
  pct: number | null;
}

/** ±5% band: strictly less than 5% away from usual reads "about usual". */
export const ABOUT_USUAL_PCT = 5;

export function compareToUsual(current: number, usual: number | null): Comparison {
  if (usual == null) return { state: "no_history", diff: null, pct: null };
  const diff = current - usual;
  if (usual <= 0) return { state: diff === 0 ? "about" : diff > 0 ? "above" : "below", diff, pct: null };
  const pct = Math.round((diff * 100) / usual);
  if (Math.abs(diff) * 100 < ABOUT_USUAL_PCT * usual) return { state: "about", diff, pct };
  return { state: diff > 0 ? "above" : "below", diff, pct };
}

export interface UsualResult {
  current: number;
  /** average over `periods` (null when there is no history) */
  usual: number | null;
  comparison: Comparison;
}

export interface UsualSet {
  period: "month" | "week";
  /** day-of-month (month) or day-of-week 1..7 (week) the comparison runs to */
  day: number;
  /** the complete periods averaged, most recent first ('YYYY-MM' or week start dates) */
  periods: string[];
  /** keys: 'total', 'group:<id>', 'category:<id>' ('uncategorised' when none) */
  byKey: Record<string, UsualResult>;
}

export const rowKeys = (r: Pick<UsualRow, "group_id" | "category_id">): string[] => ["total", `group:${r.group_id ?? "uncategorised"}`, `category:${r.category_id ?? "uncategorised"}`];

const inRange = (r: { occurred_at: string }, x: { start: string; end: string }) => r.occurred_at >= x.start && r.occurred_at < x.end;

function sumByKey(rows: UsualRow[], range: { start: string; end: string }, into: Map<string, number>): boolean {
  let any = false;
  for (const r of rows) {
    if (!inRange(r, range) || !isSpend(r)) continue;
    any = true;
    const a = signedSgdMinor(r);
    for (const k of rowKeys(r)) into.set(k, (into.get(k) ?? 0) + a);
  }
  return any;
}

function build(period: "month" | "week", day: number, current: Map<string, number>, baselines: Map<string, number>[], periods: string[]): UsualSet {
  const keys = new Set<string>(["total", ...current.keys()]);
  for (const b of baselines) for (const k of b.keys()) keys.add(k);
  const n = baselines.length;
  const byKey: Record<string, UsualResult> = {};
  for (const k of keys) {
    const cur = current.get(k) ?? 0;
    const usual = n ? Math.round(baselines.reduce((a, b) => a + (b.get(k) ?? 0), 0) / n) : null;
    byKey[k] = { current: cur, usual, comparison: compareToUsual(cur, usual) };
  }
  return { period, day, periods, byKey };
}

const hasSpend = (rows: UsualRow[], range: { start: string; end: string }) => rows.some((r) => inRange(r, range) && isSpend(r));

/**
 * Month to date vs the same point of the last `maxPeriods` complete months with data (looking back up to `lookback` months).
 * `rows` must cover the current month and the lookback window.
 */
export function monthVsUsual(rows: UsualRow[], now: string | Date | number, opts: { maxPeriods?: number; lookback?: number } = {}): UsualSet {
  const maxPeriods = opts.maxPeriods ?? 3;
  const lookback = opts.lookback ?? 12;
  const month = sgtMonth(now);
  const d = sgtParts(now).day;
  const today = sgtDate(now);
  const current = new Map<string, number>();
  sumByKey(rows, { start: monthRangeUtc(month).start, end: dayRangeUtc(today).end }, current);
  const baselines: Map<string, number>[] = [];
  const periods: string[] = [];
  for (let i = 1; i <= lookback && baselines.length < maxPeriods; i++) {
    const m = addMonths(month, -i);
    if (!hasSpend(rows, monthRangeUtc(m))) continue;
    const upto = Math.min(d, daysInMonth(m));
    const b = new Map<string, number>();
    sumByKey(rows, { start: monthRangeUtc(m).start, end: dayRangeUtc(`${m}-${String(upto).padStart(2, "0")}`).end }, b);
    baselines.push(b);
    periods.push(m);
  }
  return build("month", d, current, baselines, periods);
}

/** Week so far vs the first k days of the last `maxPeriods` complete weeks with data (looking back up to `lookback` weeks). */
export function weekVsUsual(rows: UsualRow[], now: string | Date | number, weekStart = 1, opts: { maxPeriods?: number; lookback?: number } = {}): UsualSet {
  const maxPeriods = opts.maxPeriods ?? 4;
  const lookback = opts.lookback ?? 12;
  const week = sgtWeek(now, weekStart);
  const k = week.day;
  const current = new Map<string, number>();
  sumByKey(rows, { start: week.start, end: dayRangeUtc(sgtDate(now)).end }, current);
  const baselines: Map<string, number>[] = [];
  const periods: string[] = [];
  for (let i = 1; i <= lookback && baselines.length < maxPeriods; i++) {
    const s = shiftWeek(week.startDate, -i);
    const w = weekOf(s);
    if (!hasSpend(rows, w)) continue;
    const b = new Map<string, number>();
    sumByKey(rows, { start: w.start, end: dayRangeUtc(shiftDays(s, k - 1)).end }, b); // k ≤ 7: always inside week s
    baselines.push(b);
    periods.push(s);
  }
  return build("week", k, current, baselines, periods);
}

const shiftDays = (date: string, n: number) => new Date(Date.parse(date) + n * 86400_000).toISOString().slice(0, 10);

/** Per-category rows for Reports: this period vs usual, sorted by largest increase first. */
export function categoriesVsUsual(set: UsualSet): ({ id: string } & UsualResult)[] {
  return Object.entries(set.byKey)
    .filter(([k, v]) => k.startsWith("category:") && (v.current !== 0 || (v.usual ?? 0) !== 0))
    .map(([k, v]) => ({ id: k.slice(9), ...v }))
    .sort((a, b) => (b.comparison.diff ?? b.current) - (a.comparison.diff ?? a.current) || a.id.localeCompare(b.id));
}

/** Weekly summary push line: "Lifestyle this week S$210 · usual S$185" (no usual part without history). */
export function weekUsualLine(current: number, usual: number | null): string {
  return `Lifestyle this week ${formatMoneyShort(current, "SGD")}${usual != null ? ` · usual ${formatMoneyShort(usual, "SGD")}` : ""}`;
}

/**
 * Average FULL-month spend (rows passing `filter`) over the last `maxMonths` complete months that have data (any spend).
 * Used for the emergency-fund target (Essentials, up to 6 months) and the plan's Essentials/Lifestyle baselines (3 months).
 */
export function monthlyAverage(rows: UsualRow[], now: string | Date | number, filter: (r: UsualRow) => boolean, opts: { maxMonths?: number; lookback?: number } = {}): { average: number | null; months: string[] } {
  const maxMonths = opts.maxMonths ?? 3;
  const lookback = opts.lookback ?? 12;
  const month = sgtMonth(now);
  const months: string[] = [];
  let total = 0;
  for (let i = 1; i <= lookback && months.length < maxMonths; i++) {
    const m = addMonths(month, -i);
    const range = monthRangeUtc(m);
    if (!hasSpend(rows, range)) continue;
    for (const r of rows) if (inRange(r, range) && isSpend(r) && filter(r)) total += signedSgdMinor(r);
    months.push(m);
  }
  return { average: months.length ? Math.round(total / months.length) : null, months };
}
