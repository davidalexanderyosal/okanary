import type { Account, BudgetRow, Category, CategoryGroup, MonthSummary, Transaction } from "@okanary/core";

export type TxnRowData = Transaction & { group_id: string | null; group_counts_as_spend: number | null };
export type Summary = MonthSummary & { reviewCount: number; budgets: BudgetRow[] };
export interface CategoriesResponse { groups: CategoryGroup[]; categories: Category[]; usage: Record<string, number> }

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = JSON.stringify((await res.json() as { error: unknown }).error); } catch { /* ignore */ }
    throw new Error(`${res.status}: ${msg}`);
  }
  return res.json() as Promise<T>;
}
const body = (method: string, data: unknown): RequestInit => ({ method, body: JSON.stringify(data) });

export interface NewTxn {
  amount_minor: number; currency?: string; amount_sgd_minor?: number; occurred_at?: string;
  account_id?: string | null; trip_id?: string | null; merchant?: string | null; category_id?: string | null; note?: string | null;
  is_refund?: boolean; is_reimbursable?: boolean; is_excluded?: boolean;
}

export interface RuleRow { id: string; match_type: string; pattern: string; category_id: string | null; category_name: string | null; set_excluded: number; priority: number; hits: number }
export interface FailedRaw { id: string; source: string; received_at: string; payload: string | null; error: string | null }
export interface Trip { id: string; name: string; start_date: string | null; end_date: string | null; exclude_from_monthly: number; currency: string | null; spent_sgd_minor?: number; count?: number }
export interface Subscription { id: string; merchant: string; expected_amount_sgd_minor: number | null; cadence: string | null; next_expected: string | null; category_id: string | null; active: number; confirmed_by_user: number }
export interface ImportResult {
  mode: "csv" | "text"; skipped: number; existing_in_window: number;
  applied: { corrected: number; confirmed: number; added: number } | null;
  matched: { date: string; description: string; billed: number; txn: { merchant: string | null; amount_sgd_minor: number } | null; correct_sgd_to: number | null }[];
  to_add: { date: string; description: string; amount: number }[];
  payments: { date: string; description: string; amount: number }[];
  not_on_statement: { id: string; merchant?: string | null; amount_sgd_minor?: number; occurred_at?: string }[];
}
export interface CycleInfo {
  account: { id: string; name: string; bank: string | null; last4: string | null; statement_day: number | null; due_day: number | null };
  configured: boolean;
  last_statement?: string; next_statement?: string; cycle_start?: string; due_date?: string | null;
  current_bill?: number; current_spend?: number; current_count?: number; previous_bill?: number; previous_count?: number;
}
export interface DuplicateCard { id: string; txn: TxnRowData; other: TxnRowData }
export interface RawRow { id: string; source: string; received_at: string; parse_status: string | null; error: string | null; transaction_id: string | null; preview: string | null }
export interface SetupInfo {
  email: { forward_configured: boolean; banks: Record<string, { last_at: string; failed: number }> };
  ingest_path: string; token: string | null; last_applepay_at: string | null;
  alerts: { thresholds: number[] };
  push: { configured: boolean; public_key: string | null; subscriptions: number; post_purchase: boolean; weekly_digest: boolean };
}

export const api = {
  summary: (month: string) => req<Summary>(`/api/summary?month=${month}`),
  categories: () => req<CategoriesResponse>("/api/categories"),
  accounts: () => req<Account[]>("/api/accounts"),
  transactions: (params: Record<string, string | number | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
    return req<TxnRowData[]>(`/api/transactions?${q}`);
  },
  createTxn: (t: NewTxn) => req<Transaction>("/api/transactions", body("POST", t)),
  patchTxn: (id: string, t: Partial<NewTxn> & { status?: string }) => req<Transaction>(`/api/transactions/${id}`, body("PATCH", t)),
  deleteTxn: (id: string) => req<{ ok: true }>(`/api/transactions/${id}`, { method: "DELETE" }),
  createAccount: (a: Partial<Account>) => req<Account>("/api/accounts", body("POST", a)),
  patchAccount: (id: string, a: Partial<Account>) => req<Account>(`/api/accounts/${id}`, body("PATCH", a)),
  createCategory: (c: { group_id: string; name: string }) => req<Category>("/api/categories", body("POST", c)),
  patchCategory: (id: string, c: Partial<Category>) => req<Category>(`/api/categories/${id}`, body("PATCH", c)),

  transaction: (id: string) => req<TxnRowData>(`/api/transactions/${id}`),
  review: () => req<{ items: TxnRowData[]; failed: FailedRaw[]; duplicates: DuplicateCard[] }>("/api/review"),
  mergeDuplicate: (id: string) => req<Transaction>(`/api/duplicates/${id}/merge`, { method: "POST" }),
  dismissDuplicate: (id: string) => req<{ ok: true }>(`/api/duplicates/${id}/dismiss`, { method: "POST" }),
  rawList: () => req<RawRow[]>("/api/raw-ingest?limit=100"),
  rawGet: (id: string) => req<{ id: string; payload: string | null; error: string | null }>(`/api/raw-ingest/${id}`),
  dismissRaw: (id: string) => req<{ ok: true }>(`/api/raw-ingest/${id}/dismiss`, { method: "POST" }),
  rules: () => req<RuleRow[]>("/api/rules"),
  createRule: (r: { pattern: string; category_id: string | null; match_type?: string; set_excluded?: boolean }) => req<RuleRow>("/api/rules", body("POST", r)),
  deleteRule: (id: string) => req<{ ok: true }>(`/api/rules/${id}`, { method: "DELETE" }),
  setup: () => req<SetupInfo>("/api/setup"),
  budgets: (month: string) => req<{ month: string; budgets: BudgetRow[] }>(`/api/budgets?month=${month}`),
  putBudget: (b: { scope: "group" | "category"; ref_id: string; month: string; amount_sgd_minor: number }) => req<{ month: string; budgets: BudgetRow[] }>("/api/budgets", body("PUT", b)),
  copyBudgets: (from: string, to: string) => req<{ copied: number; budgets: BudgetRow[] }>("/api/budgets/copy", body("POST", { from, to })),
  cycles: () => req<{ today: string; cycles: CycleInfo[] }>("/api/cycles"),
  trend: (months = 6, group = "lifestyle", category?: string) => req<{ group: string; points: { month: string; group: number; total: number }[] }>(`/api/trend?months=${months}&group=${group}${category ? `&category=${category}` : ""}`),
  subscriptions: () => req<{ items: Subscription[]; monthly_total: number; confirmed_total: number }>("/api/subscriptions"),
  detectSubscriptions: () => req<{ added: number; updated: number }>("/api/subscriptions/detect", { method: "POST" }),
  confirmSubscription: (id: string) => req<{ ok: true }>(`/api/subscriptions/${id}/confirm`, { method: "POST" }),
  dismissSubscription: (id: string) => req<{ ok: true }>(`/api/subscriptions/${id}/dismiss`, { method: "POST" }),
  importStatement: (b: { account_id: string; text: string; commit: boolean }) => req<ImportResult>("/api/import/statement", body("POST", b)),
  fx: (currency: string) => req<{ currency: string; rate: number; date: string }>(`/api/fx/${currency}`),
  trips: () => req<Trip[]>("/api/trips"),
  activeTrip: () => req<Trip | null>("/api/trips/active"),
  createTrip: (t: Partial<Trip>) => req<Trip>("/api/trips", body("POST", t)),
  patchTrip: (id: string, t: Partial<Trip>) => req<Trip>(`/api/trips/${id}`, body("PATCH", t)),
  deleteTrip: (id: string) => req<{ ok: true }>(`/api/trips/${id}`, { method: "DELETE" }),
  rotateToken: () => req<{ token: string }>("/api/setup/token", { method: "POST" }),
  putSettings: (s: { push_post_purchase?: boolean; push_weekly_digest?: boolean; alert_thresholds?: number[] }) => req<{ ok: true }>("/api/settings", body("PUT", s)),
  pushSubscribe: (sub: unknown) => req<{ ok: true }>("/api/push/subscribe", body("POST", sub)),
  pushUnsubscribe: (endpoint: string) => req<{ ok: true }>("/api/push/unsubscribe", body("POST", { endpoint })),
  pushTest: () => req<{ delivered: number; configured: boolean }>("/api/push/test", { method: "POST" }),
};
