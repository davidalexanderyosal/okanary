import { sgtLocalToUtc } from "@okanary/core";
import { cleanMerchant, cycleFromRenewal, toMinor, ymd } from "./common";

/**
 * Apple receipt parser (v2 S, "Apple-billed subscriptions").
 *
 * UNVERIFIED — written against invented synthetic fixtures only (worker/fixtures/synthetic-apple-receipt*.txt); needs a real
 * redacted Apple receipt from David (feature brief S, "What you (David) need to do" #2). Real Apple receipts are HTML; the
 * text produced by htmlToText is what this reads, so the layout assumed here (a "Date:" line, item blocks with the price at the
 * end of the block, a "Total" line) may well need adjusting. Anything it cannot read returns null -> a `failed` raw_ingest in Review.
 *
 * A bare `$` is SGD (a Singapore Apple ID, D-12); S$, US$, A$, HK$, NZ$, C$, EUR/GBP signs and ISO codes are recognised.
 */

export interface AppleReceiptItem {
  name: string;
  /** In the receipt's currency; null when the line has no readable price (or is free). */
  amount_minor: number | null;
  /** Next renewal 'YYYY-MM-DD' when the receipt says "Renews 5 Nov 2026". */
  renews: string | null;
  cycle: "monthly" | "yearly" | null;
}

export interface ParsedAppleReceipt {
  /** UTC ISO instant: 12:00 SGT of the receipt day. */
  date: string;
  currency: string;
  total_minor: number;
  items: AppleReceiptItem[];
}

const SYMBOLS: Record<string, string> = { "S$": "SGD", "SG$": "SGD", "$": "SGD", "US$": "USD", "A$": "AUD", "AU$": "AUD", "HK$": "HKD", "NZ$": "NZD", "C$": "CAD", "CA$": "CAD", "€": "EUR", "£": "GBP", "¥": "JPY" };
const CODES = "SGD|USD|EUR|GBP|JPY|AUD|HKD|NZD|CAD|MYR|IDR|THB|CNY|KRW|INR|PHP|TWD|CHF";
const MONEY = `(S\\$|SG\\$|US\\$|AU\\$|A\\$|HK\\$|NZ\\$|CA\\$|C\\$|\\$|€|£|¥|${CODES})\\s*(\\d[\\d.,]*)`;
const currencyOf = (sym: string) => SYMBOLS[sym] ?? sym.toUpperCase();

const DATE = /^\s*(?:receipt\s+|order\s+|invoice\s+)?date\s*:\s*(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/im;
const TOTAL = new RegExp(`^\\s*(?:order\\s+)?total\\s*(?:\\([^)]*\\))?\\s*:?\\s*${MONEY}\\s*$`, "im");
const STOP = /^\s*(sub-?total|gst|tax|vat|total|order\s+total)\b/i;
const HEADER = /^\s*(apple id|date|receipt date|order date|order id|document(?:\s+no\.?)?|billed to|payment method|sequence)\b/i;
const NOISE = /^[-=_—\s]*$|^\s*(item|description)(\s+(price|amount))?\s*$/i;
const DETAIL = /^\(?\s*(renews?\b|renewal\b|monthly\b|yearly\b|annual(?:ly)?\b|weekly\b|quarterly\b|1 (?:month|year)\b|auto-?renew|in-?app purchase|subscription\b|free trial|trial\b|report a problem)/i;
const PRICE_END = new RegExp(`^(.*?)\\s*(?:${MONEY}|\\bFree)\\s*$`, "i");
const RENEWS = /renews?(?:\s+on)?\s+(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/i;

interface Draft { name: string; details: string[]; price: { currency: string; minor: number | null } | null }

function priceOf(m: RegExpExecArray): { currency: string; minor: number | null } {
  if (!m[2]) return { currency: "", minor: null }; // "Free"
  const currency = currencyOf(m[2]);
  return { currency, minor: toMinor(currency, m[3]!) };
}

export function parseAppleReceipt(text: string): ParsedAppleReceipt | null {
  const d = DATE.exec(text);
  const total = TOTAL.exec(text);
  if (!d || !total) return null;
  const day = ymd(+d[1]!, d[2]!, +d[3]!);
  const currency = currencyOf(total[1]!);
  const totalMinor = toMinor(currency, total[2]!);
  if (!day || !totalMinor) return null;

  const lines = text.split(/\r?\n/);
  const stop = lines.findIndex((l) => STOP.test(l));
  const head = lines.slice(0, stop < 0 ? lines.length : stop);
  let start = 0;
  head.forEach((l, i) => { if (HEADER.test(l)) start = i + 1; });
  const region = head.slice(start);

  const drafts: Draft[] = [];
  let pending: Draft | null = null;
  const last = () => drafts[drafts.length - 1];
  for (const raw of region) {
    const t = raw.trim();
    if (!t || NOISE.test(t)) continue;
    const p = PRICE_END.exec(t);
    const before = (p ? p[1]! : t).trim();
    if (before && DETAIL.test(before)) {
      const target = pending ?? last();
      if (target) target.details.push(before);
    } else if (before && !pending) {
      pending = { name: cleanMerchant(before), details: [], price: null };
    }
    if (p && pending) {
      pending.price = priceOf(p);
      drafts.push(pending);
      pending = null;
    }
  }
  if (pending) drafts.push(pending);

  const items: AppleReceiptItem[] = drafts.map((x) => {
    const blob = [x.name, ...x.details].join(" ");
    const rn = RENEWS.exec(blob);
    const renews = rn ? ymd(+rn[1]!, rn[2]!, +rn[3]!) : null;
    const cycle = /\b(monthly|1 month|per month|every month)\b/i.test(blob) ? "monthly"
      : /\b(yearly|annual|annually|1 year|per year|every year)\b/i.test(blob) ? "yearly"
      : renews ? cycleFromRenewal(day, renews) : null;
    const amount = x.price && x.price.currency === currency ? x.price.minor : null;
    return { name: x.name, amount_minor: amount, renews, cycle };
  });
  if (items.length === 0) return null;
  return { date: sgtLocalToUtc(day, "12:00"), currency, total_minor: totalMinor, items };
}
