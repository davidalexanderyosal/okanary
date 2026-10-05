import { sgtDate, sgtLocalToUtc, sgtParts } from "./dates";

/**
 * Notification limit (brief "Rules for Claude Code"): besides post-purchase pushes, at most N nudge pushes per SGT day
 * (default 2) and nothing during quiet hours (default 23:00–08:00 SGT; held until the quiet period ends).
 * Pure decision logic; the worker stores held pushes in push_outbox and flushes them hourly.
 */

export interface QuietHours {
  /** minutes after SGT midnight */
  start: number;
  end: number;
}

export const DEFAULT_NUDGE_LIMIT = 2;
export const DEFAULT_QUIET: QuietHours = { start: 23 * 60, end: 8 * 60 };

/** "23:00" -> 1380. Invalid -> null. */
export function parseHm(s: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s ?? "");
  if (!m || +m[1]! > 23 || +m[2]! > 59) return null;
  return +m[1]! * 60 + +m[2]!;
}

export function parseQuietHours(start: string | null | undefined, end: string | null | undefined): QuietHours {
  const s = parseHm(start), e = parseHm(end);
  return s == null || e == null ? DEFAULT_QUIET : { start: s, end: e };
}

export function parseNudgeLimit(v: string | null | undefined): number {
  const n = Number(v);
  return v != null && v !== "" && Number.isInteger(n) && n >= 0 && n <= 20 ? n : DEFAULT_NUDGE_LIMIT;
}

const minutesOfDay = (now: Date | string | number) => {
  const p = sgtParts(now);
  return p.hour * 60 + p.minute;
};

/** Quiet hours may wrap midnight (23:00–08:00). start == end means "no quiet hours". */
export function inQuietHours(now: Date | string | number, q: QuietHours): boolean {
  if (q.start === q.end) return false;
  const m = minutesOfDay(now);
  return q.start < q.end ? m >= q.start && m < q.end : m >= q.start || m < q.end;
}

const hm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const nextDate = (date: string, n = 1) => new Date(Date.parse(date) + n * 86400_000).toISOString().slice(0, 10);

/** UTC ISO of the next moment the quiet period ends (only meaningful while inside it). */
export function quietEndsAt(now: Date | string | number, q: QuietHours): string {
  const today = sgtDate(now);
  const todayEnd = sgtLocalToUtc(today, hm(q.end));
  return Date.parse(todayEnd) > new Date(now).getTime() ? todayEnd : sgtLocalToUtc(nextDate(today), hm(q.end));
}

/** First moment of the next SGT day when nudges may go out again (the quiet end, or midnight when there are no quiet hours). */
export function nextNudgeDay(now: Date | string | number, q: QuietHours): string {
  const tomorrow = nextDate(sgtDate(now));
  return sgtLocalToUtc(tomorrow, q.start === q.end ? "00:00" : hm(q.end));
}

export type NudgeDecision = { action: "send" } | { action: "hold"; until: string; reason: "quiet" | "limit" };

/** `sentToday` = nudges already delivered this SGT day. */
export function nudgeDecision(now: Date | string | number, sentToday: number, limit: number, q: QuietHours): NudgeDecision {
  if (inQuietHours(now, q)) return { action: "hold", until: quietEndsAt(now, q), reason: "quiet" };
  if (sentToday >= limit) return { action: "hold", until: nextNudgeDay(now, q), reason: "limit" };
  return { action: "send" };
}

/** Held pushes older than this are dropped rather than delivered late. */
export const OUTBOX_MAX_AGE_MS = 72 * 3600_000;
