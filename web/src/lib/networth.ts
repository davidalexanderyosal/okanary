import { isDecimal, isNegativeDecimal, normalizeDecimal, parseMajorToMinor } from "@okanary/core";
import type { NwHeadline, NwKind } from "./api";
import { sgd, timeLabel } from "./format";

/** "+S$1,240" / "−S$340" (true minus sign). Zero has no sign. */
export function signedSgd(minor: number): string {
  if (minor === 0) return sgd(0);
  return `${minor > 0 ? "+" : "−"}${sgd(Math.abs(minor))}`;
}

/** Home's single net worth line. The month change is left out when unknown. Never a daily move. */
export function homeNetWorthLine(net: number, monthChange: number | null | undefined): string {
  const base = `Net worth ${sgd(net)}`;
  return monthChange == null ? base : `${base} · ${signedSgd(monthChange)} this month`;
}

/** "updated 12 days ago" / "updated today" / "updated yesterday"; null age = no balance entered yet. */
export function updatedAgoText(ageDays: number | null | undefined): string {
  if (ageDays == null) return "no balance yet";
  if (ageDays <= 0) return "updated today";
  if (ageDays === 1) return "updated yesterday";
  return `updated ${ageDays} days ago`;
}

/** Toast for the 5-minute refresh limit (HTTP 429 with retry_after_s). */
export function refreshLimitedText(retryAfterS: number): string {
  const min = Math.max(1, Math.ceil(retryAfterS / 60));
  return `Prices refresh at most every 5 minutes. Try again in ${min} min.`;
}

/** "Prices as of 06:30" (SGT), or null before the first run. */
export function pricesAsOfText(lastRefreshAt: string | null | undefined): string | null {
  return lastRefreshAt ? `Prices as of ${timeLabel(lastRefreshAt)}` : null;
}

/** "Today: +S$120 · market" — the flows/market split of the day is shown as a single honest label. */
export function todayText(day: { change: number; flows: number; market: number }): string {
  const label = day.flows === 0 ? "market" : day.market === 0 ? "you saved" : "market + savings";
  return `Today: ${signedSgd(day.change)} · ${label}`;
}

/** Range chips for the area chart: label and the `days` sent to /api/networth/history. */
export const RANGES = [{ id: "3m", label: "3M", days: 92 }, { id: "1y", label: "1Y", days: 365 }, { id: "all", label: "All", days: 3650 }] as const;

export interface AreaPoint { date: string; cash: number; stocks: number; crypto: number; other: number; liabilities: number; net: number }

/**
 * History rows (SGD minor units) -> chart rows in whole dollars (axis only; the source stays in minor units).
 * Liabilities become a negative number so they draw below zero.
 */
export function toAreaData(rows: Pick<NwHeadline, "date" | "net" | "classes">[]): AreaPoint[] {
  const d = (minor: number) => minor / 100;
  return rows.map((r) => ({
    date: r.date, cash: d(r.classes.cash), stocks: d(r.classes.stocks), crypto: d(r.classes.crypto), other: d(r.classes.other),
    liabilities: r.classes.liabilities === 0 ? 0 : -d(r.classes.liabilities), net: d(r.net),
  }));
}

export const KIND_ORDER: NwKind[] = ["cash", "brokerage", "crypto", "manual_asset", "liability"];
export const KIND_LABEL: Record<NwKind, string> = { cash: "Cash", brokerage: "Brokerage", crypto: "Crypto", manual_asset: "Other assets", liability: "Loans & other liabilities" };

/** Group accounts by kind in display order, skipping empty groups. */
export function groupByKind<T extends { kind: NwKind }>(accounts: T[]): { kind: NwKind; label: string; items: T[] }[] {
  return KIND_ORDER.map((kind) => ({ kind, label: KIND_LABEL[kind], items: accounts.filter((a) => a.kind === kind) })).filter((g) => g.items.length > 0);
}

/** Quantity stays a decimal string: valid plain decimal, > 0, no exponent. Returns the normalised string or null. */
export function parseQuantity(input: string): string | null {
  const s = input.trim();
  if (!isDecimal(s) || isNegativeDecimal(s)) return null;
  const n = normalizeDecimal(s);
  return /[1-9]/.test(n) ? n : null;
}

/** Money text -> minor units in `currency`, or null when empty/invalid (or negative unless allowed). */
export function parseMoneyInput(input: string, currency: string, allowNegative = false): number | null {
  if (input.trim() === "") return null;
  try {
    const m = parseMajorToMinor(input, currency);
    return m < 0 && !allowNegative ? null : m;
  } catch {
    return null;
  }
}
