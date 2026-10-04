import { addMonths, categoriesVsUsual, compareToUsual, dayRangeUtc, monthRangeUtc, monthVsUsual, sgtDate, sgtMonth, weekVsUsual, type UsualResult, type UsualRow, type UsualSet } from "@okanary/core";
import { loadAllowanceSettings } from "./allowance";
import { TXN_WITH_GROUP_SQL } from "./db";

/** Rows from the start of the month 12 months back until the end of today (SGT): covers both baselines' lookback. */
export async function loadUsualRows(db: D1Database, now: Date): Promise<UsualRow[]> {
  const start = monthRangeUtc(addMonths(sgtMonth(now), -12)).start;
  const end = dayRangeUtc(sgtDate(now)).end;
  return (await db.prepare(`${TXN_WITH_GROUP_SQL} WHERE t.occurred_at >= ?1 AND t.occurred_at < ?2`).bind(start, end).all<UsualRow>()).results;
}

/** A key's result, or zero spend (usual 0 once there is any history, null without) when nothing was spent in it. */
export const usualFor = (set: UsualSet, key: string): UsualResult => {
  const found = set.byKey[key];
  if (found) return found;
  const usual = set.periods.length ? 0 : null;
  return { current: 0, usual, comparison: compareToUsual(0, usual) };
};

export async function loadUsual(db: D1Database, now: Date) {
  const rows = await loadUsualRows(db, now);
  const { weekStart } = await loadAllowanceSettings(db);
  const month = monthVsUsual(rows, now);
  const week = weekVsUsual(rows, now, weekStart);
  return {
    month: { day: month.day, periods: month.periods, total: usualFor(month, "total"), lifestyle: usualFor(month, "group:lifestyle"), categories: categoriesVsUsual(month) },
    week: { day: week.day, periods: week.periods, total: usualFor(week, "total"), lifestyle: usualFor(week, "group:lifestyle") },
  };
}
