import { currencyExponent } from "./money";

/**
 * Decimal strings for holdings quantities (v2 N): crypto needs 8+ decimal places, so quantities are stored as TEXT and
 * handled here with BigInt. Never floats. A value is coef / 10^scale.
 */
interface Dec { coef: bigint; scale: number }

const DEC_RE = /^([+-])?(\d+)?(?:\.(\d+))?$/;

function parse(s: string): Dec {
  const t = String(s).trim();
  const m = DEC_RE.exec(t);
  if (!m || (m[2] === undefined && m[3] === undefined)) throw new Error(`Invalid decimal: "${s}"`);
  const frac = m[3] ?? "";
  const coef = BigInt((m[2] ?? "0") + frac);
  return { coef: m[1] === "-" ? -coef : coef, scale: frac.length };
}

export function isDecimal(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = DEC_RE.exec(s.trim());
  return !!m && (m[2] !== undefined || m[3] !== undefined);
}

function toStr(d: Dec): string {
  let { coef, scale } = d;
  while (scale > 0 && coef % 10n === 0n) { coef /= 10n; scale--; }
  const neg = coef < 0n;
  let digits = (neg ? -coef : coef).toString();
  if (scale > 0) {
    digits = digits.padStart(scale + 1, "0");
    digits = digits.slice(0, -scale) + "." + digits.slice(-scale);
  }
  return (neg && digits !== "0" ? "-" : "") + digits;
}

const align = (a: Dec, b: Dec): [bigint, bigint, number] => {
  const s = Math.max(a.scale, b.scale);
  return [a.coef * 10n ** BigInt(s - a.scale), b.coef * 10n ** BigInt(s - b.scale), s];
};

/** Canonical form: no leading '+', no trailing zeros, "-0" → "0" ("1.2500" → "1.25", ".5" → "0.5"). */
export const normalizeDecimal = (s: string): string => toStr(parse(s));

export function addDecimal(a: string, b: string): string {
  const [x, y, s] = align(parse(a), parse(b));
  return toStr({ coef: x + y, scale: s });
}

export function subDecimal(a: string, b: string): string {
  const [x, y, s] = align(parse(a), parse(b));
  return toStr({ coef: x - y, scale: s });
}

export function cmpDecimal(a: string, b: string): -1 | 0 | 1 {
  const [x, y] = align(parse(a), parse(b));
  return x < y ? -1 : x > y ? 1 : 0;
}

export const isZeroDecimal = (a: string) => parse(a).coef === 0n;
export const isNegativeDecimal = (a: string) => parse(a).coef < 0n;

/** Round half away from zero of num/den (den > 0). */
function roundDivBig(num: bigint, den: bigint): bigint {
  const neg = num < 0n;
  const q = ((neg ? -num : num) * 2n + den) / (2n * den);
  return neg ? -q : q;
}

/** quantity × price (price in minor units per 1 unit of the asset) → minor units, rounded half away from zero. */
export function mulDecimalByMinor(quantity: string, priceMinor: number): number {
  if (!Number.isSafeInteger(priceMinor)) throw new Error(`price must be an integer minor amount, got ${priceMinor}`);
  const q = parse(quantity);
  const out = roundDivBig(q.coef * BigInt(priceMinor), 10n ** BigInt(q.scale));
  const n = Number(out);
  if (!Number.isSafeInteger(n)) throw new Error("value out of range");
  return n;
}

/** minor × basis points / 10000, rounded half away from zero (shares of a holding/account: 10000 bp = 100%). */
export function applyBp(minor: number, bp: number): number {
  if (!Number.isSafeInteger(minor) || !Number.isInteger(bp)) throw new Error("applyBp needs integers");
  return Number(roundDivBig(BigInt(minor) * BigInt(bp), 10000n));
}

/**
 * A price as an API returns it (JSON number or numeric string, in major units) → integer minor units of `currency`,
 * rounded half up. Numbers are expanded with toFixed so 1e-7 style values never reach the parser.
 */
export function apiPriceToMinor(v: number | string, currency: string): number | null {
  const s = typeof v === "number" ? (Number.isFinite(v) ? v.toFixed(12) : "") : String(v).trim();
  if (!isDecimal(s)) return null;
  const d = parse(s);
  if (d.coef < 0n) return null;
  const exp = currencyExponent(currency);
  const out = Number(roundDivBig(d.coef * 10n ** BigInt(exp), 10n ** BigInt(d.scale)));
  return Number.isSafeInteger(out) ? out : null;
}
