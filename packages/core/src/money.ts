/**
 * Money is ALWAYS an integer count of ISO 4217 minor units. Never floats.
 * The only non-integer input is an FX rate, which is converted to a scaled
 * BigInt so the arithmetic stays exact and only the final rounding is applied.
 */

/** ISO 4217 minor-unit exponents for currencies we expect. Default is 2. */
const EXPONENTS: Record<string, number> = {
  SGD: 2, USD: 2, EUR: 2, GBP: 2, AUD: 2, MYR: 2, THB: 2, HKD: 2, CNY: 2, IDR: 2, INR: 2, NZD: 2, CAD: 2, CHF: 2, PHP: 2, TWD: 2,
  JPY: 0, KRW: 0, VND: 0, CLP: 0, ISK: 0,
  BHD: 3, KWD: 3, OMR: 3, JOD: 3, TND: 3,
};

export function currencyExponent(currency: string): number {
  return EXPONENTS[currency.toUpperCase()] ?? 2;
}

export const SUPPORTED_CURRENCIES = Object.keys(EXPONENTS);

function assertInt(n: number, what: string): void {
  if (!Number.isSafeInteger(n)) throw new Error(`${what} must be a safe integer minor-unit amount, got ${n}`);
}

/**
 * Parse a decimal string ("12.50", "1,200", "45") into minor units without floats.
 * Extra fractional digits beyond the currency exponent are rounded half-up.
 */
export function parseMajorToMinor(input: string, currency: string): number {
  const exp = currencyExponent(currency);
  const s = input.trim().replace(/,/g, "");
  const m = /^(-)?(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === "" && (m[3] === undefined || m[3] === ""))) throw new Error(`Invalid amount: "${input}"`);
  const neg = m[1] === "-";
  const whole = m[2] || "0";
  let frac = m[3] ?? "";
  let roundUp = false;
  if (frac.length > exp) {
    roundUp = frac.charCodeAt(exp) >= 53; // '5'
    frac = frac.slice(0, exp);
  }
  frac = frac.padEnd(exp, "0");
  let minor = Number(whole + frac);
  if (roundUp) minor += 1;
  assertInt(minor, "amount");
  return neg ? -minor : minor;
}

/** Format minor units as a plain decimal string ("12.50"). */
export function minorToDecimalString(minor: number, currency: string): string {
  assertInt(minor, "minor");
  const exp = currencyExponent(currency);
  const neg = minor < 0;
  const abs = Math.abs(minor);
  if (exp === 0) return (neg ? "-" : "") + String(abs);
  const s = String(abs).padStart(exp + 1, "0");
  return (neg ? "-" : "") + s.slice(0, -exp) + "." + s.slice(-exp);
}

const SYMBOLS: Record<string, string> = { SGD: "S$", USD: "US$", JPY: "¥", IDR: "Rp", EUR: "€", GBP: "£", KRW: "₩", AUD: "A$", MYR: "RM", THB: "฿" };

export const currencySymbol = (currency: string): string => SYMBOLS[currency.toUpperCase()] ?? currency.toUpperCase() + " ";

function groupThousands(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Human display e.g. "S$1,234.50". `compact` drops cents for SGD >= 100. */
export function formatMoney(minor: number, currency = "SGD", opts: { compact?: boolean } = {}): string {
  const cur = currency.toUpperCase();
  const sym = SYMBOLS[cur] ?? cur + " ";
  const neg = minor < 0;
  let dec = minorToDecimalString(Math.abs(minor), cur);
  if (opts.compact && currencyExponent(cur) > 0 && Math.abs(minor) >= 10 ** (currencyExponent(cur) + 2)) {
    dec = dec.split(".")[0]!;
  }
  const [i, f] = dec.split(".");
  return (neg ? "-" : "") + sym + groupThousands(i!) + (f !== undefined ? "." + f : "");
}

export function addMinor(...xs: number[]): number {
  let t = 0;
  for (const x of xs) {
    assertInt(x, "operand");
    t += x;
  }
  assertInt(t, "sum");
  return t;
}

const RATE_SCALE = 1_000_000_000n; // 1e9

function rateToScaled(rate: number): bigint {
  if (!(rate > 0) || !Number.isFinite(rate)) throw new Error(`Invalid FX rate: ${rate}`);
  // toFixed(9) avoids exponent notation; BigInt from the digit string stays exact.
  const [i, f = ""] = rate.toFixed(9).split(".");
  return BigInt(i! + f.padEnd(9, "0").slice(0, 9));
}

/**
 * Convert minor units of `from` into minor units of `to` using `rate`
 * (1 unit of `from` = `rate` units of `to`). Rounds half away from zero.
 */
export function convertMinor(amountMinor: number, from: string, to: string, rate: number): number {
  assertInt(amountMinor, "amount");
  if (from.toUpperCase() === to.toUpperCase()) return amountMinor;
  const shift = currencyExponent(to) - currencyExponent(from);
  const neg = amountMinor < 0;
  let num = BigInt(Math.abs(amountMinor)) * rateToScaled(rate);
  let den = RATE_SCALE;
  if (shift > 0) num *= 10n ** BigInt(shift);
  else if (shift < 0) den *= 10n ** BigInt(-shift);
  const q = (num * 2n + den) / (den * 2n); // round half up on the magnitude
  const out = Number(q);
  assertInt(out, "converted amount");
  return neg ? -out : out;
}

/** Split `total` minor units into `parts` near-equal integer parts that sum exactly. */
export function allocate(total: number, parts: number): number[] {
  assertInt(total, "total");
  if (!Number.isInteger(parts) || parts <= 0) throw new Error("parts must be a positive integer");
  const base = Math.trunc(total / parts);
  let rem = total - base * parts;
  const step = rem < 0 ? -1 : 1;
  return Array.from({ length: parts }, () => {
    if (rem !== 0) {
      rem -= step;
      return base + step;
    }
    return base;
  });
}

/** Integer percentage (rounded) of part/whole; 0 when whole is 0. */
export function percentOf(part: number, whole: number): number {
  if (whole === 0) return 0;
  return Math.round((part * 100) / whole);
}
