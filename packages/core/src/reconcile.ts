import { addDays } from "./cycle";
import { sgtDate } from "./dates";
import { merchantSimilarity, normalizeMerchant } from "./merchant";
import { looksLikePayment, type StatementRow } from "./statement";

/** Statement reconcile (spec §3.2): match by amount / date / merchant, add what's missing, correct final billed SGD amounts. */
export interface ExistingTxn {
  id: string;
  occurred_at: string;
  amount_minor: number;
  currency: string;
  amount_sgd_minor: number;
  merchant: string | null;
  is_refund: number;
  status: string;
}

export interface Match { row: StatementRow; txnId: string; /** set when the txn's SGD amount differs from the billed one */ correctSgdTo?: number }
export interface ReconcilePlan {
  matched: Match[];
  /** statement lines with no counterpart: to be added as imported transactions */
  toAdd: StatementRow[];
  /** card payments / bill payments on the statement: ignored */
  payments: StatementRow[];
  /** our records inside the statement window that the statement doesn't list (informational; never deleted) */
  notOnStatement: string[];
}

const DATE_WINDOW_DAYS = 4;
const dayDiff = (a: string, b: string) => Math.abs(Math.round((Date.parse(a) - Date.parse(b)) / 86400_000));
const within = (a: number, b: number, pct: number) => Math.abs(a - b) <= Math.max(1, Math.floor((Math.max(a, b) * pct) / 100));

export function reconcile(rows: StatementRow[], existing: ExistingTxn[]): ReconcilePlan {
  const payments: StatementRow[] = [];
  const candidates: StatementRow[] = [];
  for (const r of rows) (r.amount_minor < 0 && looksLikePayment(r.description) ? payments : candidates).push(r);

  type Pair = { ri: number; ti: number; score: number };
  const pairs: Pair[] = [];
  candidates.forEach((r, ri) => {
    const isCredit = r.amount_minor < 0;
    const amt = Math.abs(r.amount_minor);
    existing.forEach((t, ti) => {
      if (t.status === "void" || !!t.is_refund !== isCredit) return;
      const dd = dayDiff(r.date, sgtDate(t.occurred_at));
      if (dd > DATE_WINDOW_DAYS) return;
      const sim = merchantSimilarity(normalizeMerchant(r.description), t.merchant ?? "");
      let amountScore = 0;
      if (t.amount_sgd_minor === amt) amountScore = 3;
      else if (within(t.amount_sgd_minor, amt, 1)) amountScore = 2;
      // The billed amount can sit a few % above what we recorded: an FX estimate that drifted, or a foreign purchase typed in as an
      // SGD guess before the bank's FX fee. Accept up to 6% only when the merchant also looks like the same one.
      else if (within(t.amount_sgd_minor, amt, 6) && sim >= (t.currency !== "SGD" ? 0.25 : 0.5)) amountScore = 1;
      if (amountScore === 0) return;
      pairs.push({ ri, ti, score: amountScore * 100 + Math.round(sim * 50) - dd * 5 });
    });
  });
  pairs.sort((a, b) => b.score - a.score);
  const usedR = new Set<number>(), usedT = new Set<number>();
  const matched: Match[] = [];
  for (const p of pairs) {
    if (usedR.has(p.ri) || usedT.has(p.ti)) continue;
    usedR.add(p.ri); usedT.add(p.ti);
    const r = candidates[p.ri]!, t = existing[p.ti]!;
    const billed = Math.abs(r.amount_minor);
    matched.push({ row: r, txnId: t.id, ...(t.amount_sgd_minor !== billed ? { correctSgdTo: billed } : {}) });
  }
  const toAdd = candidates.filter((_, i) => !usedR.has(i));

  let notOnStatement: string[] = [];
  if (rows.length > 0) {
    const dates = rows.map((r) => r.date).sort();
    const lo = dates[0]!, hi = dates[dates.length - 1]!;
    notOnStatement = existing.filter((t, i) => !usedT.has(i) && t.status !== "void" && sgtDate(t.occurred_at) >= addDays(lo, 0) && sgtDate(t.occurred_at) <= hi).map((t) => t.id);
  }
  return { matched, toAdd, payments, notOnStatement };
}
