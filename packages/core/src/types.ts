import type { TxnStatus } from "./spend";

export interface Account {
  id: string; name: string; kind: "credit" | "debit" | "cash" | "ewallet";
  bank: string | null; last4: string | null; wallet_card_name: string | null;
  statement_day: number | null; due_day: number | null; currency: string; archived: number;
}
export interface CategoryGroup { id: string; name: string; counts_as_spend: number; sort: number }
export interface Category { id: string; group_id: string; name: string; icon: string | null; color: string | null; sort: number; archived: number }

export interface Transaction {
  id: string; occurred_at: string; account_id: string | null;
  amount_minor: number; currency: string; amount_sgd_minor: number; fx_rate: number | null;
  fx_source: "same" | "bank" | "ecb" | "statement" | "manual" | null;
  merchant_raw: string | null; merchant: string | null;
  category_id: string | null; category_source: "rule" | "history" | "ai" | "user" | null;
  status: TxnStatus; source: "manual" | "applepay" | "email" | "import";
  is_refund: number; is_reimbursable: number; is_excluded: number;
  trip_id: string | null; note: string | null; recurring_id: string | null;
  created_at: string; updated_at: string;
}

export interface BucketTotal { id: string; spent: number; count: number }
export interface MonthSummary {
  month: string;
  /** Total spend per the spend definition, SGD minor units. */
  total: number;
  /** Same total through the same calendar day of the previous month. */
  totalLastMonthToDate: number;
  byGroup: BucketTotal[];
  /** Groups with counts_as_spend=0 (Savings, Income, Transfers): display-only, never part of `total`. */
  byGroupNonSpend: BucketTotal[];
  byCategory: BucketTotal[];
  /** Spend per SGT day: index 0 = day 1. */
  daily: number[];
  /** Same, split by category group id (or 'uncategorised'). */
  dailyByGroup: Record<string, number[]>;
  /** Top merchants by spend this month (normalised names), max 10. */
  topMerchants: BucketTotal[];
  needsReviewCount: number;
  pendingCount: number;
  daysInMonth: number;
  day: number;
}
