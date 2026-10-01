import { formatMoney } from "./money";

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
