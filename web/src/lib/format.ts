import { addMonths, formatMoney, sgtDate, sgtParts } from "@okanary/core";

export const sgd = (minor: number, compact = true) => formatMoney(minor, "SGD", { compact });

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function monthLabel(month: string): string {
  const [y, m] = month.split("-");
  return `${MONTHS[+m! - 1]} ${y}`;
}

export function dayLabel(utcIso: string, today: string): string {
  const d = sgtDate(utcIso);
  if (d === today) return "Today";
  const { year, month, day } = sgtParts(utcIso);
  const dow = DAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${dow} ${day} ${MONTHS[month - 1]}`;
}

export function timeLabel(utcIso: string): string {
  const p = sgtParts(utcIso);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

export { addMonths };

/** "SQ *YA KUN" is stored normalised ("YA KUN"); show it as "Ya Kun". */
export function prettyMerchant(m: string | null | undefined): string {
  if (!m) return "";
  return m.toLowerCase().replace(/(^|[\s/&-])([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase());
}

/** '2026-09-12' -> '12 Sep' */
export function shortDate(ymd: string): string {
  const [, m, d] = ymd.split("-");
  return `${+d!} ${MONTHS[+m! - 1]}`;
}
