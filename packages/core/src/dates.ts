/**
 * All month/day boundaries are computed in Asia/Singapore (UTC+8, no DST since 1982).
 * Timestamps are stored as UTC ISO-8601 strings. Because SGT is a fixed offset we
 * use exact integer arithmetic instead of Intl (identical results, no runtime quirks);
 * dates.test.ts cross-checks against Intl for Asia/Singapore.
 */
export const SGT_TZ = "Asia/Singapore";
const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SgtParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
}

function toMs(utcIso: string | Date | number): number {
  const ms = utcIso instanceof Date ? utcIso.getTime() : typeof utcIso === "number" ? utcIso : Date.parse(utcIso);
  if (Number.isNaN(ms)) throw new Error(`Invalid timestamp: ${String(utcIso)}`);
  return ms;
}

export function sgtParts(utc: string | Date | number): SgtParts {
  const d = new Date(toMs(utc) + SGT_OFFSET_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}

const p2 = (n: number) => String(n).padStart(2, "0");

/** 'YYYY-MM' of the SGT month containing this instant. */
export function sgtMonth(utc: string | Date | number): string {
  const p = sgtParts(utc);
  return `${p.year}-${p2(p.month)}`;
}

/** 'YYYY-MM-DD' of the SGT day containing this instant. */
export function sgtDate(utc: string | Date | number): string {
  const p = sgtParts(utc);
  return `${p.year}-${p2(p.month)}-${p2(p.day)}`;
}

export function parseMonth(month: string): { year: number; month: number } {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m || +m[2]! < 1 || +m[2]! > 12) throw new Error(`Invalid month: ${month}`);
  return { year: +m[1]!, month: +m[2]! };
}

export function daysInMonth(month: string): number {
  const { year, month: mo } = parseMonth(month);
  return new Date(Date.UTC(year, mo, 0)).getUTCDate();
}

export function addMonths(month: string, delta: number): string {
  const { year, month: mo } = parseMonth(month);
  const idx = year * 12 + (mo - 1) + delta;
  return `${Math.floor(idx / 12)}-${p2((idx % 12) + 1)}`;
}

/** UTC instant of 00:00 SGT on the given SGT calendar date. */
export function sgtMidnightUtc(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day) - SGT_OFFSET_MS);
}

/** [start, end) UTC ISO range of an SGT calendar month. */
export function monthRangeUtc(month: string): { start: string; end: string } {
  const { year, month: mo } = parseMonth(month);
  return {
    start: sgtMidnightUtc(year, mo, 1).toISOString(),
    end: sgtMidnightUtc(year, mo + 1, 1).toISOString(),
  };
}

/** [start, end) UTC ISO range of an SGT calendar day 'YYYY-MM-DD'. */
export function dayRangeUtc(date: string): { start: string; end: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`Invalid date: ${date}`);
  const s = sgtMidnightUtc(+m[1]!, +m[2]!, +m[3]!);
  return { start: s.toISOString(), end: new Date(s.getTime() + DAY_MS).toISOString() };
}

/** UTC instant for a SGT wall-clock date + time ("2026-10-01", "14:30"). */
export function sgtLocalToUtc(date: string, time = "00:00"): string {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!d || !t) throw new Error(`Invalid SGT date/time: ${date} ${time}`);
  return new Date(Date.UTC(+d[1]!, +d[2]! - 1, +d[3]!, +t[1]!, +t[2]!) - SGT_OFFSET_MS).toISOString();
}

/** Where we are in the month, as seen in SGT. day is 1-based; daysLeft includes today. */
export function monthProgress(now: string | Date | number): { month: string; day: number; daysInMonth: number; daysLeft: number } {
  const p = sgtParts(now);
  const month = `${p.year}-${p2(p.month)}`;
  const dim = daysInMonth(month);
  return { month, day: p.day, daysInMonth: dim, daysLeft: dim - p.day + 1 };
}

/**
 * End-of-day cutoff (exclusive, UTC ISO) for "same day last month":
 * day-of-month is clamped to the length of the previous month.
 */
export function sameDayLastMonthCutoff(now: string | Date | number): { start: string; end: string } {
  const p = sgtParts(now);
  const prev = addMonths(`${p.year}-${p2(p.month)}`, -1);
  const { year, month } = parseMonth(prev);
  const day = Math.min(p.day, daysInMonth(prev));
  return { start: monthRangeUtc(prev).start, end: dayRangeUtc(`${year}-${p2(month)}-${p2(day)}`).end };
}

/** Monday-start SGT week containing the instant: [start, end) UTC ISO. */
export function sgtWeekRangeUtc(now: string | Date | number): { start: string; end: string } {
  const p = sgtParts(now);
  const midnight = sgtMidnightUtc(p.year, p.month, p.day);
  const dow = new Date(midnight.getTime() + SGT_OFFSET_MS).getUTCDay(); // 0=Sun
  const sinceMonday = (dow + 6) % 7;
  const start = new Date(midnight.getTime() - sinceMonday * DAY_MS);
  return { start: start.toISOString(), end: new Date(start.getTime() + 7 * DAY_MS).toISOString() };
}

// ---------- configurable weeks (v2 feature A) ----------

/** Day of week of an SGT calendar date 'YYYY-MM-DD': 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`Invalid date: ${date}`);
  return new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!)).getUTCDay();
}

function shiftDate(date: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`Invalid date: ${date}`);
  const t = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]! + days));
  return `${t.getUTCFullYear()}-${p2(t.getUTCMonth() + 1)}-${p2(t.getUTCDate())}`;
}

/** Week start day setting: 0 = Sunday, 1 = Monday (default) … 6 = Saturday. Anything invalid falls back to Monday. */
export function parseWeekStart(v: string | number | null | undefined): number {
  const n = Number(v);
  return v != null && v !== "" && Number.isInteger(n) && n >= 0 && n <= 6 ? n : 1;
}

/** First SGT calendar date of the week containing `date`. */
export function weekStartDate(date: string, weekStart = 1): string {
  return shiftDate(date, -((dayOfWeek(date) - weekStart + 7) % 7));
}

export interface SgtWeek {
  /** first and last SGT calendar dates of the week (inclusive) */
  startDate: string;
  endDate: string;
  /** [start, end) UTC ISO */
  start: string;
  end: string;
  /** 1-based day of the week for `now` (1 = the week's first day) and days left including today */
  day: number;
  daysLeft: number;
  /** alert_log period label 'YYYY-Www' (ISO week of the week's first day) */
  label: string;
}

/** The SGT week (configurable start day) containing the instant. */
export function sgtWeek(now: string | Date | number, weekStart = 1): SgtWeek {
  return weekOf(weekStartDate(sgtDate(now), weekStart), sgtDate(now));
}

/** Week starting on `startDate`; `today` (an SGT date) sets day/daysLeft (clamped to the week). */
export function weekOf(startDate: string, today: string = startDate): SgtWeek {
  const endDate = shiftDate(startDate, 6);
  const idx = today < startDate ? 0 : today > endDate ? 6 : Math.round((Date.parse(today) - Date.parse(startDate)) / DAY_MS);
  return {
    startDate, endDate,
    start: dayRangeUtc(startDate).start, end: dayRangeUtc(endDate).end,
    day: idx + 1, daysLeft: 7 - idx, label: isoWeekLabel(startDate),
  };
}

/** Week immediately before/after the given one (by start date). */
export const shiftWeek = (startDate: string, weeks: number): string => shiftDate(startDate, weeks * 7);

/** ISO-8601 week label 'YYYY-Www' of a calendar date. */
export function isoWeekLabel(date: string): string {
  const dow = dayOfWeek(date) || 7; // Mon=1..Sun=7
  const thursday = shiftDate(date, 4 - dow);
  const year = +thursday.slice(0, 4);
  const jan1 = Date.UTC(year, 0, 1);
  const week = Math.floor((Date.parse(thursday) - jan1) / DAY_MS / 7) + 1;
  return `${year}-W${p2(week)}`;
}
