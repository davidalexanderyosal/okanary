import { dayRangeUtc, daysInMonth } from "./dates";

/** Card-cycle maths (spec §1 rule 5, §7.5). All dates are SGT calendar dates 'YYYY-MM-DD'. */
const p2 = (n: number) => String(n).padStart(2, "0");
const fmt = (y: number, m: number, d: number) => `${y}-${p2(m)}-${p2(d)}`;

function parseDate(d: string): { y: number; m: number; d: number } {
  const x = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!x) throw new Error(`Invalid date: ${d}`);
  return { y: +x[1]!, m: +x[2]!, d: +x[3]! };
}

export function addDays(date: string, n: number): string {
  const { y, m, d } = parseDate(date);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

const monthKey = (y: number, m: number) => `${y}-${p2(m)}`;
function shiftMonth(y: number, m: number, delta: number): { y: number; m: number } {
  const idx = y * 12 + (m - 1) + delta;
  return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
}
/** day-of-month `day` in (y,m), clamped to the month's length (statement day 31 -> 30 Apr, 28 Feb). */
function clamped(y: number, m: number, day: number): string {
  return fmt(y, m, Math.min(day, daysInMonth(monthKey(y, m))));
}

/** Latest statement date <= today. */
export function lastStatementDate(statementDay: number, today: string): string {
  const { y, m } = parseDate(today);
  const thisMonth = clamped(y, m, statementDay);
  if (thisMonth <= today) return thisMonth;
  const p = shiftMonth(y, m, -1);
  return clamped(p.y, p.m, statementDay);
}

/** Earliest statement date > today. */
export function nextStatementDate(statementDay: number, today: string): string {
  const { y, m } = parseDate(today);
  const thisMonth = clamped(y, m, statementDay);
  if (thisMonth > today) return thisMonth;
  const n = shiftMonth(y, m, 1);
  return clamped(n.y, n.m, statementDay);
}

/** Payment due date for a statement: the first `dueDay` strictly after the statement date. */
export function dueDateAfter(statementDate: string, dueDay: number): string {
  const { y, m } = parseDate(statementDate);
  const sameMonth = clamped(y, m, dueDay);
  if (sameMonth > statementDate) return sameMonth;
  const n = shiftMonth(y, m, 1);
  return clamped(n.y, n.m, dueDay);
}

export interface CycleBounds {
  lastStatement: string;
  nextStatement: string;
  /** previous statement (start of the previous, already-billed cycle is the day after this) */
  prevStatement: string;
  /** first day of the current cycle (the day after the last statement) */
  cycleStart: string;
  /** UTC range of the current (still open) cycle: [start, end of nextStatement day) */
  current: { start: string; end: string };
  /** UTC range of the last billed cycle (what the most recent statement covers) */
  previous: { start: string; end: string };
  /** due date of the LAST statement, if a due day is known */
  dueDate: string | null;
}

export function cycleBounds(statementDay: number, dueDay: number | null, today: string): CycleBounds {
  const lastStatement = lastStatementDate(statementDay, today);
  const nextStatement = nextStatementDate(statementDay, today);
  const prevStatement = lastStatementDate(statementDay, addDays(lastStatement, -1));
  const cycleStart = addDays(lastStatement, 1);
  return {
    lastStatement, nextStatement, prevStatement, cycleStart,
    current: { start: dayRangeUtc(cycleStart).start, end: dayRangeUtc(nextStatement).end },
    previous: { start: dayRangeUtc(addDays(prevStatement, 1)).start, end: dayRangeUtc(lastStatement).end },
    dueDate: dueDay ? dueDateAfter(lastStatement, dueDay) : null,
  };
}

