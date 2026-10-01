import { addMonths, daysInMonth, monthProgress, sameDayLastMonthCutoff, sgtParts, monthRangeUtc } from "./dates";
import { isSpend, signedSgdMinor, type SpendRow } from "./spend";
import type { BucketTotal, MonthSummary } from "./types";

export interface SummaryRow extends SpendRow {
  occurred_at: string;
  category_id: string | null;
  group_id: string | null;
}

export const UNCATEGORISED = "uncategorised";

function bump(map: Map<string, BucketTotal>, id: string, amt: number) {
  const b = map.get(id) ?? { id, spent: 0, count: 0 };
  b.spent += amt;
  b.count += 1;
  map.set(id, b);
}

/**
 * Build a month summary from rows. `rows` must cover the SGT month AND the
 * previous month (for the month-to-date comparison); anything else is ignored.
 * Every figure goes through isSpend/signedSgdMinor.
 */
export function summarizeMonth(rows: SummaryRow[], month: string, now: string | Date | number): MonthSummary {
  const range = monthRangeUtc(month);
  const dim = daysInMonth(month);
  const prog = monthProgress(now);
  const isCurrent = prog.month === month;
  const day = isCurrent ? prog.day : month < prog.month ? dim : 0;
  const prevRange = isCurrent ? sameDayLastMonthCutoff(now) : { start: monthRangeUtc(addMonths(month, -1)).start, end: monthRangeUtc(addMonths(month, -1)).end };
  if (!isCurrent && month >= prog.month) {
    // future month: nothing to compare
    prevRange.end = prevRange.start;
  }

  let total = 0;
  let prevTotal = 0;
  const groups = new Map<string, BucketTotal>();
  const cats = new Map<string, BucketTotal>();
  const daily = Array.from({ length: dim }, () => 0);
  let needsReview = 0;
  let pending = 0;

  for (const r of rows) {
    const inMonth = r.occurred_at >= range.start && r.occurred_at < range.end;
    const inPrev = r.occurred_at >= prevRange.start && r.occurred_at < prevRange.end;
    if (!inMonth && !inPrev) continue;
    if (!isSpend(r)) continue;
    const amt = signedSgdMinor(r);
    if (inPrev) prevTotal += amt;
    if (!inMonth) continue;
    total += amt;
    bump(groups, r.group_id ?? UNCATEGORISED, amt);
    bump(cats, r.category_id ?? UNCATEGORISED, amt);
    daily[sgtParts(r.occurred_at).day - 1]! += amt;
    if (r.status === "needs_review") needsReview++;
    if (r.status === "pending") pending++;
  }

  return {
    month, total, totalLastMonthToDate: prevTotal,
    byGroup: [...groups.values()], byCategory: [...cats.values()].sort((a, b) => b.spent - a.spent),
    daily, needsReviewCount: needsReview, pendingCount: pending, daysInMonth: dim, day,
  };
}
