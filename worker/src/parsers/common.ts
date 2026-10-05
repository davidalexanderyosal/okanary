import { normaliseNumber, parseMajorToMinor, sgtLocalToUtc, sgtParts } from "@okanary/core";

export interface ParsedAlert {
  amount_minor: number;
  currency: string;
  merchant: string;
  card_last4: string | null;
  /** UTC ISO instant of the purchase. */
  occurred_at: string;
  /** SGD amount, only if the bank's email states it (fx_source 'bank'). */
  sgd_minor?: number;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
export const monthNum = (s: string): number | null => MONTHS[s.slice(0, 3).toLowerCase()] ?? null;

const p2 = (n: number) => String(n).padStart(2, "0");

/**
 * Alert emails give SGT wall-clock times, often without a year. Infer it from when the email was received:
 * take the received year, and step back a year if that would put the purchase more than a day in the future (Dec email read in Jan).
 */
export function sgtWallToUtc(day: number, month: number, year: number | undefined, hh: number, mm: number, receivedAt: string): string {
  let y = year ?? sgtParts(receivedAt).year;
  let iso = sgtLocalToUtc(`${y}-${p2(month)}-${p2(day)}`, `${p2(hh)}:${p2(mm)}`);
  if (year === undefined && Date.parse(iso) > Date.parse(receivedAt) + 24 * 3600_000) {
    y -= 1;
    iso = sgtLocalToUtc(`${y}-${p2(month)}-${p2(day)}`, `${p2(hh)}:${p2(mm)}`);
  }
  return iso;
}

export function toMinor(currency: string, numText: string): number | null {
  try {
    const m = parseMajorToMinor(normaliseNumber(numText, currency), currency);
    return m > 0 ? m : null;
  } catch {
    return null;
  }
}

export const cleanMerchant = (s: string) => s.replace(/\s+/g, " ").replace(/[.\s]+$/, "").trim();

/** HTML -> readable text, keeping table rows as "Label: value" lines. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|tr|div|li|h\d)>/gi, "\n")
    .replace(/<\/(td|th)>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 'YYYY-MM-DD' from day / month name / year, or null when it isn't a real calendar date. */
export function ymd(day: number, monthName: string, year: number): string | null {
  const m = monthNum(monthName);
  if (!m || year < 2000 || year > 2100 || day < 1 || day > 31) return null;
  if (new Date(Date.UTC(year, m - 1, day)).getUTCDate() !== day) return null;
  return `${year}-${p2(m)}-${p2(day)}`;
}

/** Billing cycle implied by the gap between a receipt date and its renewal date ('YYYY-MM-DD'); null when it is neither ~1 month nor ~1 year. */
export function cycleFromRenewal(date: string, renews: string): "monthly" | "yearly" | null {
  const days = (Date.parse(renews) - Date.parse(date)) / 86400_000;
  if (days >= 25 && days <= 35) return "monthly";
  if (days >= 355 && days <= 375) return "yearly";
  return null;
}
