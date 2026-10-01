export interface MerchantRule {
  id: string;
  match_type: "exact" | "prefix" | "contains" | "regex";
  pattern: string;
  category_id: string | null;
  set_excluded: number;
  priority: number;
}

const SPECIFICITY: Record<MerchantRule["match_type"], number> = { exact: 4, prefix: 3, contains: 2, regex: 1 };

/** Patterns are compared against the NORMALISED (uppercase) merchant. */
export function ruleMatches(rule: MerchantRule, merchant: string): boolean {
  const m = merchant.toUpperCase();
  const p = rule.pattern.toUpperCase().replace(/\*+$/, ""); // "GRAB*" == prefix GRAB
  switch (rule.match_type) {
    case "exact": return m === p;
    case "prefix": return m.startsWith(p);
    case "contains": return m.includes(p);
    case "regex":
      try { return new RegExp(rule.pattern, "i").test(merchant); } catch { return false; }
  }
}

/** Highest priority wins; ties broken by specificity (exact > prefix > contains > regex), then longer pattern. */
export function findRule(rules: MerchantRule[], merchant: string): MerchantRule | null {
  const hits = rules.filter((r) => ruleMatches(r, merchant));
  if (hits.length === 0) return null;
  hits.sort((a, b) => b.priority - a.priority || SPECIFICITY[b.match_type] - SPECIFICITY[a.match_type] || b.pattern.length - a.pattern.length);
  return hits[0]!;
}
