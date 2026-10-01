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
  /** 1 when the transaction belongs to a trip flagged exclude_from_monthly (spec §3.2 trips). Optional: absent = 0. */
  trip_excluded?: number | boolean | null;
}

export interface SpendOptions {
  /** Trip views count trip-excluded rows (the trip's own total); every monthly view leaves them out. */
  ignoreTripExclusion?: boolean;
}

export function isSpend(r: SpendRow, opts: SpendOptions = {}): boolean {
  if (r.status === "void") return false;
  if (r.is_excluded || r.is_reimbursable) return false;
  if (r.trip_excluded && !opts.ignoreTripExclusion) return false; // D-39
  if (r.group_counts_as_spend == null) return true; // uncategorised: counts (D-02)
  return !!r.group_counts_as_spend;
}

/** Signed SGD minor amount: refunds negative. Independent of whether the row counts as spend. */
export function signedSgdMinor(r: Pick<SpendRow, "is_refund" | "amount_sgd_minor">): number {
  return r.is_refund ? -r.amount_sgd_minor : r.amount_sgd_minor;
}

/** Contribution of a row to any spend total (0 when it doesn't count). */
export function spendAmount(r: SpendRow, opts: SpendOptions = {}): number {
  return isSpend(r, opts) ? signedSgdMinor(r) : 0;
}

export function sumSpend(rows: SpendRow[], opts: SpendOptions = {}): number {
  let t = 0;
  for (const r of rows) t += spendAmount(r, opts);
  return t;
}
