/**
 * Merchant normalisation (spec §4.4): uppercase, strip payment-processor prefixes
 * (SQ *, GPAY*, PAYPAL *, ...), trailing location/ID codes and repeated spaces.
 * The raw string is always kept separately (merchant_raw).
 */
const PREFIXES = [
  /^SQ\s*\*\s*/, /^SP\s*\*\s*/, /^TST\s*\*\s*/, /^GPAY\s*\*\s*/, /^GOOGLE\s*\*\s*PAY\s*/, /^PAYPAL\s*\*\s*/, /^PP\s*\*\s*/,
  /^APPLE\s*PAY\s*/, /^APL\s*\*\s*PAY\s*/, /^IZ\s*\*\s*/, /^CKO\s*\*\s*/, /^STRIPE\s*\*\s*/, /^PAYU\s*\*\s*/, /^2C2P\s*\*\s*/,
];
const COUNTRY_TAIL = /\s+(SINGAPORE|SINGAPO|SGP|SG|JAKARTA|ID|IDN|TOKYO|JP|JPN|MY|MYS|KUALA LUMPUR)$/;

export function normalizeMerchant(raw: string): string {
  let s = raw.normalize("NFKC").toUpperCase().replace(/\s+/g, " ").trim();
  for (const p of PREFIXES) {
    if (p.test(s)) {
      s = s.replace(p, "");
      break;
    }
  }
  // "GRAB*A-3JKD92" / "AMZN MKTP SG*AB12CD" -> keep the head before '*'
  const star = s.indexOf("*");
  if (star > 2) s = s.slice(0, star);
  s = s.replace(/\*/g, " ");
  // trailing store numbers / order ids / '#123' / long alnum tokens containing digits
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s
      .replace(COUNTRY_TAIL, "")
      .replace(/\s+#?\d{1,}$/, (m) => (/^\s+#?\d{1,3}$/.test(m) || /#/.test(m) ? "" : m))
      .replace(/\s+(?=\S*\d)[A-Z0-9-]{5,}$/, "")
      .replace(/\s+\d{4,}$/, "")
      .trim();
    if (s === before) break;
  }
  return s.replace(/\s+/g, " ").trim() || raw.toUpperCase().trim();
}

/** Token-overlap (Jaccard) similarity in [0,1] between two normalised merchants. Used by Phase 3 dedup. */
export function merchantSimilarity(a: string, b: string): number {
  const ta = new Set(normalizeMerchant(a).split(/[^A-Z0-9]+/).filter(Boolean));
  const tb = new Set(normalizeMerchant(b).split(/[^A-Z0-9]+/).filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  // also treat substring containment of the whole name as strong overlap (e.g. "YA KUN" vs "YA KUN KAYA TOAST")
  const containment = inter / Math.min(ta.size, tb.size);
  return Math.max(inter / (ta.size + tb.size - inter), containment * 0.9);
}
