import { formatMoney, formatMoneyShort } from "./money";

export interface PurchaseNudge {
  amountMinor: number;
  currency: string;
  merchant: string | null;
  categoryName: string | null;
  lifestyleSpentSgd: number;
  /** Lifestyle monthly budget in SGD minor units, when one is set (Phase 4). */
  lifestyleBudgetSgd?: number | null;
  day: number;
  daysInMonth: number;
}

/** "S$14.50 · Ya Kun · Coffee — Lifestyle S$642 / S$900 (day 14/31)" */
export function purchaseNudgeBody(n: PurchaseNudge): string {
  const parts = [formatMoney(n.amountMinor, n.currency), n.merchant, n.categoryName ?? "needs a category"].filter(Boolean);
  const life = n.lifestyleBudgetSgd
    ? `Lifestyle ${formatMoney(n.lifestyleSpentSgd, "SGD", { compact: true })} / ${formatMoney(n.lifestyleBudgetSgd, "SGD", { compact: true })}`
    : `Lifestyle ${formatMoney(n.lifestyleSpentSgd, "SGD", { compact: true })}`;
  return `${parts.join(" · ")} — ${life} (day ${n.day}/${n.daysInMonth})`;
}

export interface WeeklyDigest {
  weekTotalSgd: number;
  lifestyleSpentSgd: number;
  lifestyleBudgetSgd?: number | null;
  /** even-pace amount the Lifestyle budget would have reached by today */
  lifestyleExpectedSgd?: number | null;
  top: { merchant: string; amountSgd: number }[];
}

/** Sunday-evening digest (spec §3.2): "This week S$312 · Lifestyle S$642 / S$900 (pace S$580) · Biggest: Uniqlo S$128, ..." */
export function weeklyDigestBody(d: WeeklyDigest): string {
  const f = (n: number) => formatMoneyShort(n, "SGD");
  const life = d.lifestyleBudgetSgd
    ? `Lifestyle ${f(d.lifestyleSpentSgd)} / ${f(d.lifestyleBudgetSgd)}${d.lifestyleExpectedSgd != null ? ` (pace ${f(d.lifestyleExpectedSgd)})` : ""}`
    : `Lifestyle ${f(d.lifestyleSpentSgd)} this month`;
  const top = d.top.length ? ` · Biggest: ${d.top.map((t) => `${t.merchant} ${f(t.amountSgd)}`).join(", ")}` : "";
  return `This week ${f(d.weekTotalSgd)} · ${life}${top}`;
}
