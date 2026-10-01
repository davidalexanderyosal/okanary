import { currencyExponent, parseMajorToMinor } from "./money";

export interface ParsedAmount { amount_minor: number; currency: string }

/**
 * Symbol/prefix -> ISO currency. Longest match first (so "US$" beats "$").
 * Decision D-12: a bare "$" means SGD (this is a Singapore-based user); "US$" is USD.
 */
const SYMBOLS: [string, string][] = [
  ["S$", "SGD"], ["SGD", "SGD"], ["US$", "USD"], ["USD", "USD"], ["A$", "AUD"], ["AUD", "AUD"], ["HK$", "HKD"], ["HKD", "HKD"],
  ["NZ$", "NZD"], ["NT$", "TWD"], ["C$", "CAD"], ["RM", "MYR"], ["MYR", "MYR"], ["IDR", "IDR"], ["RP", "IDR"], ["JPY", "JPY"],
  ["EUR", "EUR"], ["GBP", "GBP"], ["THB", "THB"], ["KRW", "KRW"], ["CNY", "CNY"], ["RMB", "CNY"], ["INR", "INR"], ["VND", "VND"],
  ["PHP", "PHP"], ["CHF", "CHF"],
  ["€", "EUR"], ["£", "GBP"], ["¥", "JPY"], ["￥", "JPY"], ["₩", "KRW"], ["฿", "THB"], ["₹", "INR"], ["₫", "VND"], ["₱", "PHP"], ["$", "SGD"],
].sort((a, b) => b[0].length - a[0].length) as [string, string][];

const BIG_DENOMINATION = new Set(["IDR", "VND", "KRW", "JPY"]);

/** Turn "1.234,56" / "1,234.56" / "45.000" / "12,50" into a plain "1234.56" string. */
export function normaliseNumber(raw: string, currency: string): string {
  const s = raw.replace(/\s/g, "");
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastDot !== -1 && lastComma !== -1) {
    const dec = lastDot > lastComma ? "." : ",";
    const thou = dec === "." ? "," : ".";
    return s.split(thou).join("").replace(dec, ".");
  }
  const sep = lastDot !== -1 ? "." : lastComma !== -1 ? "," : null;
  if (!sep) return s;
  const parts = s.split(sep);
  if (parts.length > 2) return parts.join(""); // 1.234.567 -> thousands
  const after = parts[1]!;
  if (after.length === 3) {
    // "1,200" is always thousands; "45.000" is thousands for big-denomination currencies (Rp 45.000)
    if (sep === "," || BIG_DENOMINATION.has(currency) || currencyExponent(currency) === 0) return parts.join("");
  }
  return `${parts[0]}.${after}`;
}

/**
 * Parse the amount text Apple's Shortcuts Wallet trigger gives us: "S$12.50", "Rp 45.000", "¥1,200", "$8.90", "12.50 SGD".
 * Returns null when no amount can be read. Amount is always positive; sign is carried by is_refund elsewhere.
 */
export function parseShortcutAmount(input: string | number, fallbackCurrency = "SGD"): ParsedAmount | null {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input <= 0) return null;
    try {
      return { amount_minor: parseMajorToMinor(String(input), fallbackCurrency), currency: fallbackCurrency };
    } catch {
      return null;
    }
  }
  const text = input.trim().replace(/ /g, " ");
  const num = /\d[\d.,\s]*\d|\d/.exec(text);
  if (!num) return null;
  const before = text.slice(0, num.index).trim().toUpperCase();
  const after = text.slice(num.index + num[0].length).trim().toUpperCase();
  let currency = fallbackCurrency;
  const hit = SYMBOLS.find(([sym]) => before.endsWith(sym) || after.startsWith(sym));
  if (hit) currency = hit[1];
  const negative = /^[-−(]/.test(before) || /^-/.test(text);
  try {
    const minor = parseMajorToMinor(normaliseNumber(num[0].trim(), currency), currency);
    if (minor <= 0) return null;
    void negative; // refunds from Wallet arrive as separate positive notifications; handled by caller if needed
    return { amount_minor: minor, currency };
  } catch {
    return null;
  }
}
