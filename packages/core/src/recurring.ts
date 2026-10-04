import { daysInMonth, sgtDate } from "./dates";

/** Subscription / recurring-charge detection (spec §3.2): same merchant, similar amount, roughly monthly. */
export interface RecurringTxn {
  merchant: string | null;
  occurred_at: string;
  amount_sgd_minor: number;
  category_id: string | null;
}

export interface RecurringCandidate {
  merchant: string;
  expected_amount_sgd_minor: number;
  cadence: "monthly";
  occurrences: number;
  last_date: string;
  next_expected: string;
  category_id: string | null;
}

/** v2 S: a candidate needs 2 consecutive monthly charges (gap 25–36 days, amounts within ±15%) (D-64). */
export const MIN_OCCURRENCES = 2;
const MIN_GAP = 25;
const MAX_GAP = 36;
const STALE_AFTER_DAYS = 45;

function daysBetween(a: string, b: string): number {
  const p = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
  return Math.round((p(b) - p(a)) / 86400_000);
}

/** Same day-of-month next month, clamped (31 Jan -> 28 Feb). */
export function addOneMonth(date: string): string {
  const y = +date.slice(0, 4), m = +date.slice(5, 7), d = +date.slice(8, 10);
  const idx = y * 12 + (m - 1) + 1;
  const ny = Math.floor(idx / 12), nm = (idx % 12) + 1;
  const key = `${ny}-${String(nm).padStart(2, "0")}`;
  return `${key}-${String(Math.min(d, daysInMonth(key))).padStart(2, "0")}`;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
};

/** within ±15% of the reference (never tighter than ±S$1, so cents jitter on tiny fees doesn't break a run) */
const similarAmount = (a: number, ref: number) => Math.abs(a - ref) <= Math.max(100, Math.floor(ref * 0.15));

/**
 * `rows` must already be spend rows (spend definition applied, refunds removed). Finds merchants whose MOST RECENT run of
 * charges is ≥2 long with ~monthly gaps and similar amounts, and whose last charge is recent (a cancelled service goes quiet).
 */
export function detectMonthly(rows: RecurringTxn[], now: string | Date): RecurringCandidate[] {
  const today = sgtDate(now);
  const byMerchant = new Map<string, { date: string; amt: number; cat: string | null }[]>();
  for (const r of rows) {
    if (!r.merchant || r.amount_sgd_minor <= 0) continue;
    (byMerchant.get(r.merchant) ?? byMerchant.set(r.merchant, []).get(r.merchant)!).push({ date: sgtDate(r.occurred_at), amt: r.amount_sgd_minor, cat: r.category_id });
  }
  const out: RecurringCandidate[] = [];
  for (const [merchant, list] of byMerchant) {
    list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const run = [list[list.length - 1]!];
    for (let i = list.length - 2; i >= 0; i--) {
      const gap = daysBetween(list[i]!.date, run[0]!.date);
      if (gap === 0) continue; // two charges the same day are not two cycles
      if (gap < MIN_GAP || gap > MAX_GAP) break;
      if (!similarAmount(list[i]!.amt, median(run.map((x) => x.amt)))) break;
      run.unshift(list[i]!);
    }
    if (run.length < MIN_OCCURRENCES) continue;
    const last = run[run.length - 1]!;
    if (daysBetween(last.date, today) > STALE_AFTER_DAYS) continue;
    const cats = new Map<string, number>();
    for (const r of run) if (r.cat) cats.set(r.cat, (cats.get(r.cat) ?? 0) + 1);
    const cat = [...cats.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    out.push({ merchant, expected_amount_sgd_minor: median(run.map((x) => x.amt)), cadence: "monthly", occurrences: run.length, last_date: last.date, next_expected: addOneMonth(last.date), category_id: cat });
  }
  return out.sort((a, b) => b.expected_amount_sgd_minor - a.expected_amount_sgd_minor || a.merchant.localeCompare(b.merchant));
}

