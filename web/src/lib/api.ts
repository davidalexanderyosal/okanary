import type { Account, Category, CategoryGroup, MonthSummary, Transaction } from "@okanary/core";

export type TxnRowData = Transaction & { group_id: string | null; group_counts_as_spend: number | null };
export type Summary = MonthSummary & { reviewCount: number };
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
  account_id?: string | null; merchant?: string | null; category_id?: string | null; note?: string | null;
  is_refund?: boolean; is_reimbursable?: boolean; is_excluded?: boolean;
}

export interface RuleRow { id: string; match_type: string; pattern: string; category_id: string | null; category_name: string | null; set_excluded: number; priority: number; hits: number }
export interface FailedRaw { id: string; source: string; received_at: string; payload: string | null; error: string | null }
export interface DuplicateCard { id: string; txn: TxnRowData; other: TxnRowData }
export interface RawRow { id: string; source: string; received_at: string; parse_status: string | null; error: string | null; transaction_id: string | null; preview: string | null }
export interface SetupInfo {
  email: { forward_configured: boolean; banks: Record<string, { last_at: string; failed: number }> };
  ingest_path: string; token: string | null; last_applepay_at: string | null;
  push: { configured: boolean; public_key: string | null; subscriptions: number; post_purchase: boolean };
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
  rotateToken: () => req<{ token: string }>("/api/setup/token", { method: "POST" }),
  putSettings: (s: { push_post_purchase?: boolean }) => req<{ ok: true }>("/api/settings", body("PUT", s)),
  pushSubscribe: (sub: unknown) => req<{ ok: true }>("/api/push/subscribe", body("POST", sub)),
  pushUnsubscribe: (endpoint: string) => req<{ ok: true }>("/api/push/unsubscribe", body("POST", { endpoint })),
  pushTest: () => req<{ delivered: number; configured: boolean }>("/api/push/test", { method: "POST" }),
};
