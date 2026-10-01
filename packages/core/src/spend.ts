/**
 * THE spend definition (spec §6). Every total in the app goes through here.
 *
 *   status != 'void' AND is_excluded = 0 AND is_reimbursable = 0 AND group.counts_as_spend = 1
 *   refunds count as negatives.
 *
 * Decision (DECISIONS.md D-02): a transaction with NO category yet (e.g. awaiting
 * review) has no group; it still counts as spend so that pending/uncategorised
 * purchases are never hidden from the month total. It is reported under the
 * synthetic "uncategorised" bucket.
 */
export type TxnStatus = "pending" | "needs_review" | "confirmed" | "void";

export interface SpendRow {
  status: TxnStatus;
  is_excluded: number | boolean;
  is_reimbursable: number | boolean;
  is_refund: number | boolean;
  amount_sgd_minor: number;
  /** counts_as_spend of the transaction's category group; null/undefined when uncategorised. */
  group_counts_as_spend: number | boolean | null | undefined;
}

export function isSpend(r: SpendRow): boolean {
  if (r.status === "void") return false;
  if (r.is_excluded || r.is_reimbursable) return false;
  if (r.group_counts_as_spend == null) return true; // uncategorised: counts (D-02)
  return !!r.group_counts_as_spend;
}

/** Signed SGD minor amount: refunds negative. Independent of whether the row counts as spend. */
export function signedSgdMinor(r: Pick<SpendRow, "is_refund" | "amount_sgd_minor">): number {
  return r.is_refund ? -r.amount_sgd_minor : r.amount_sgd_minor;
}

/** Contribution of a row to any spend total (0 when it doesn't count). */
export function spendAmount(r: SpendRow): number {
  return isSpend(r) ? signedSgdMinor(r) : 0;
}

export function sumSpend(rows: SpendRow[]): number {
  let t = 0;
  for (const r of rows) t += spendAmount(r);
  return t;
}
