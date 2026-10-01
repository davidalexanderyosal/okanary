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
};
