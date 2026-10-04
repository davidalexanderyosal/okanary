import type { Account, CatalogueItem, Cycle, SubStatus, Breakdown, BudgetRow, CardLiability, FundingType, GoalKind, GoalState, GoalStatus, Horizon, NwKind, Category, CategoryGroup, MonthSummary, Transaction, UsualResult, WeekAllowance, WeekSafeToSpend } from "@okanary/core";

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
export type SubscriptionSource = "detected" | "manual" | "apple_receipt" | "email_receipt";
/** One row of GET /api/subscriptions (v2 S): the table row plus derived numbers, flags and the cost in goal terms. All SGD amounts are minor units. */
export interface SubscriptionItem {
  id: string; name: string; catalogue_key: string | null; amount_minor: number | null; currency: string; expected_sgd_minor: number; cycle: Cycle;
  next_renewal: string | null; account_id: string | null; category_id: string | null; source: SubscriptionSource; status: SubStatus;
  trial_ends: string | null; merchant_pattern: string | null; last_charged: string | null; pending_price_sgd_minor: number | null; group_id: string | null;
  monthly_equivalent: number; yearly_equivalent: number;
  flags: { missing: boolean; price_change: boolean; trial_ending: boolean; renewal_soon: boolean };
  cancel_url: string | null;
  goal_impact: { goal_id: string; goal_name: string; weeks_earlier: number | null; reachable_only_if_cancelled: boolean; text: string } | null;
}
export interface SubscriptionTotals { monthly: number; yearly: number; essentials: number; lifestyle: number; count: number }
export interface SubscriptionsResponse { items: SubscriptionItem[]; totals: SubscriptionTotals; catalogue: CatalogueItem[] }
/** POST/PATCH body for a subscription (money in minor units; the API converts a foreign price to SGD). */
export interface SubscriptionInput {
  name?: string; catalogue_key?: string | null; amount_minor?: number; currency?: string; cycle?: Cycle; next_renewal?: string;
  account_id?: string | null; category_id?: string | null; trial_ends?: string | null; status?: SubStatus;
}
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
/** GET /api/usual: "vs your usual" (v2 U). `periods` = the complete months/weeks averaged; `categories` sorted by largest increase. */
export interface UsualResponse {
  month: { day: number; periods: string[]; total: UsualResult; lifestyle: UsualResult; categories: ({ id: string } & UsualResult)[] };
  week: { day: number; periods: string[]; total: UsualResult; lifestyle: UsualResult };
}
export interface SetupInfo {
  email: { forward_configured: boolean; banks: Record<string, { last_at: string; failed: number }> };
  ingest_path: string; token: string | null; last_applepay_at: string | null;
  alerts: { thresholds: number[] };
  push: { configured: boolean; public_key: string | null; subscriptions: number; post_purchase: boolean; weekly_digest: boolean };
  allowance_settings: { week_start: number; override_minor: number | null; carry: boolean };
  notifications: { daily_limit: number; quiet_start: string; quiet_end: string };
  wants: { long_wait_threshold_minor: number };
}
/** GET /api/allowance: this week's Lifestyle allowance (v2 A). All amounts SGD minor units. */
export interface Allowance {
  week: { startDate: string; endDate: string; day: number; daysLeft: number; label: string };
  allowance: WeekAllowance;
  spent: number;
  safe: WeekSafeToSpend;
  week_start: number;
  carry: boolean;
  override_minor: number | null;
  month: { budget: number | null; spent: number };
}
export interface SettingsInput {
  push_post_purchase?: boolean; push_weekly_digest?: boolean; alert_thresholds?: number[];
  week_start?: number; allowance_override_minor?: number | null; allowance_carry?: boolean;
  nudge_daily_limit?: number; quiet_start?: string; quiet_end?: string;
  want_long_wait_threshold_minor?: number;
}

// ---- Want list (v2 W) ----
export type WantStatus = "waiting" | "ready" | "bought" | "skipped";
export interface WantItem {
  id: string; name: string; price_minor: number; currency: string; price_sgd_minor: number;
  url: string | null; note: string | null; category_id: string | null;
  wait_days: number; added_at: string; decide_after: string;
  status: WantStatus; decided_at: string | null; transaction_id: string | null; bought_early: number;
  left: { days: number; hours: number; due: boolean };
}
export interface WantStats { year: number; skipped_total_minor: number; skipped_count: number }
export interface WantsResponse {
  waiting: WantItem[]; ready: WantItem[]; decided: WantItem[]; stats: WantStats;
  receiving_goal: { id: string; name: string; emoji: string | null } | null;
}
export interface WantInput {
  name: string; price_minor: number; currency?: string; price_sgd_minor?: number;
  url?: string | null; note?: string | null; category_id?: string | null; wait_days?: number;
}
export type WantMatch = TxnRowData;
export interface WantSkipOffer { goal_id: string; name: string; emoji: string | null; amount: number }

// ---- Net worth (v2 N) ----
export type { NwKind };
export interface NwAccountRow { id: string; name: string; kind: NwKind; institution: string | null; currency: string; include_in_networth: number; archived: number }
export interface NwBalanceRow { id: string; account_id: string; amount_minor: number; currency: string; as_of: string; note: string | null; flow_minor: number | null }
export interface NwAccountView extends NwAccountRow { balance: NwBalanceRow | null; value_sgd: number | null; age_days: number | null; needs_update: boolean }
export interface NwHoldingRow { id: string; account_id: string; asset_type: "us_equity" | "crypto"; symbol: string; quantity: string; cost_basis_minor: number | null; cost_currency: string | null; acquired_at: string | null }
export interface NwHoldingView extends NwHoldingRow {
  price_minor: number | null; price_currency: string | null; value_sgd: number | null; gain_sgd: number | null; day_move_sgd: number | null; stale: boolean; quote_date: string | null;
}
export interface NwChange { from: string; to: string; change: number; flows: number; market: number; partial: boolean }
export interface NwHeadline { date: string; net: number; assets: number; liabilities: number; classes: Breakdown["classes"]; flows: number; market: number }
export interface NetworthResponse {
  today: string;
  latest: NwHeadline | null;
  change: { month: NwChange | null; ytd: NwChange | null; day: { date: string; flows: number; market: number; change: number } | null };
  accounts: NwAccountView[];
  holdings: NwHoldingView[];
  cards: (CardLiability & { last_statement: string | null; previous_bill: number; previous_paid: boolean })[];
  last_refresh_at: string | null;
  live: boolean;
  attribution: string;
}
export interface NwRefreshResult { date: string; net: number; flows: number; market: number; fetched: number; failed: string[]; stale: string[] }
export interface NwAccountInput { name: string; kind: NwKind; institution?: string | null; currency?: string; include_in_networth?: boolean; archived?: boolean }
export interface NwBalanceInput { amount_minor: number; currency?: string; as_of?: string; note?: string | null; flow_minor?: number | null }
export interface NwHoldingInput { account_id: string; asset_type: "us_equity" | "crypto"; symbol: string; quantity: string; cost_basis_minor?: number | null; cost_currency?: string | null; acquired_at?: string | null }

// ---- Goals (v2 G) ----
export type { GoalKind, GoalState, GoalStatus, Horizon, FundingType };
export interface GoalFundingRow { id: string; goal_id: string; source_type: FundingType; source_id: string; share_bp: number | null; earmark_minor: number | null }
export interface GoalContribution {
  id: string; goal_id: string; period: string; amount_sgd_minor: number; source: "underspend" | "want_skipped" | "commission" | "manual";
  status: "pledged" | "transferred" | "skipped"; created_at: string; resolved_at: string | null;
}
export type GoalWarning =
  | { type: "earmark_over"; account_id: string; claimed: number; balance: number; goal_ids: string[] }
  | { type: "share_over"; source_type: "nw_account" | "holding"; source_id: string; total_bp: number; goal_ids: string[] };
export interface GoalView {
  id: string; name: string; emoji: string | null; kind: GoalKind; priority: number;
  target_date: string | null; start_date: string | null; created_at: string;
  target_today_minor: number; inflation_bp: number | null;
  horizon: Horizon; return_bp: number; return_bp_is_default: boolean;
  /** target at the target date (inflated for mid/long) */
  target: number;
  /** progress: linked values + earmarks (+ transferred contributions for goals without share links) */
  value: number;
  value_parts: { linked: number; earmarked: number; contributions: number; counts_contributions: boolean };
  /** net monthly saving over the last 3 months (market excluded); null until there is an earlier snapshot */
  pace: number | null;
  status: GoalStatus;
  range: { conservative: number; base: number; optimistic: number } | null;
  totals: { transferred: number; pledged: number; skipped: number };
  pledges: GoalContribution[];
  funding: GoalFundingRow[];
  warnings: GoalWarning[];
  planned_monthly_minor: number | null;
  receives_underspend: boolean;
  safer_funding_suggested: boolean;
}
export interface GoalsResponse { today: string; goals: GoalView[]; summary: string | null; receiving_goal_id: string | null; warnings: GoalWarning[] }
export interface GoalDetail extends GoalView {
  history: { date: string; value_sgd_minor: number }[];
  contributions: GoalContribution[];
  /** projected value per month from today (index 0 = today) at the current pace */
  path: number[];
  cone: { conservative: number[]; optimistic: number[] } | null;
}
export interface EmergencySuggestion { average: number | null; months: string[]; target: number | null }
export interface GoalInput {
  name: string; emoji: string | null; kind: GoalKind; target_today_minor: number; target_date: string | null;
  inflation_bp: number | null; return_bp: number | null; receives_underspend: boolean;
}
export interface GoalFundingInput { source_type: FundingType; source_id: string; share_bp?: number; earmark_minor?: number }

/** Thrown by refreshNetworth when the 5-minute limit applies (HTTP 429). */
export class RefreshLimitedError extends Error {
  constructor(public retryAfterS: number) { super("refreshed a moment ago"); }
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
  allowance: () => req<Allowance>("/api/allowance"),
  usual: () => req<UsualResponse>("/api/usual"),
  budgets: (month: string) => req<{ month: string; budgets: BudgetRow[] }>(`/api/budgets?month=${month}`),
  putBudget: (b: { scope: "group" | "category"; ref_id: string; month: string; amount_sgd_minor: number }) => req<{ month: string; budgets: BudgetRow[] }>("/api/budgets", body("PUT", b)),
  copyBudgets: (from: string, to: string) => req<{ copied: number; budgets: BudgetRow[] }>("/api/budgets/copy", body("POST", { from, to })),
  cycles: () => req<{ today: string; cycles: CycleInfo[] }>("/api/cycles"),
  trend: (months = 6, group = "lifestyle", category?: string) => req<{ group: string; points: { month: string; group: number; total: number }[] }>(`/api/trend?months=${months}&group=${group}${category ? `&category=${category}` : ""}`),
  subscriptions: () => req<SubscriptionsResponse>("/api/subscriptions"),
  detectSubscriptions: () => req<{ added: number; updated: number }>("/api/subscriptions/detect", { method: "POST" }),
  createSubscription: (input: SubscriptionInput) => req<SubscriptionItem & { merged: boolean }>("/api/subscriptions", body("POST", input)),
  patchSubscription: (id: string, input: SubscriptionInput) => req<SubscriptionItem>(`/api/subscriptions/${id}`, body("PATCH", input)),
  confirmSubscription: (id: string) => req<{ ok: true }>(`/api/subscriptions/${id}/confirm`, { method: "POST" }),
  dismissSubscription: (id: string) => req<{ ok: true }>(`/api/subscriptions/${id}/dismiss`, { method: "POST" }),
  acceptSubscriptionPrice: (id: string) => req<{ ok: true }>(`/api/subscriptions/${id}/accept-price`, { method: "POST" }),
  reviewSubscriptionPrice: (id: string) => req<{ ok: true }>(`/api/subscriptions/${id}/review-price`, { method: "POST" }),
  cancelIntentSubscription: (id: string) => req<{ ok: true; cancel_url: string | null }>(`/api/subscriptions/${id}/cancel-intent`, { method: "POST" }),
  markSubscriptionCancelled: (id: string) => req<{ ok: true }>(`/api/subscriptions/${id}/cancelled`, { method: "POST" }),
  keepSubscription: (id: string) => req<{ ok: true }>(`/api/subscriptions/${id}/keep`, { method: "POST" }),
  remindSubscriptionLater: (id: string) => req<{ ok: true }>(`/api/subscriptions/${id}/remind-later`, { method: "POST" }),
  importStatement: (b: { account_id: string; text: string; commit: boolean }) => req<ImportResult>("/api/import/statement", body("POST", b)),
  fx: (currency: string) => req<{ currency: string; rate: number; date: string }>(`/api/fx/${currency}`),
  trips: () => req<Trip[]>("/api/trips"),
  activeTrip: () => req<Trip | null>("/api/trips/active"),
  createTrip: (t: Partial<Trip>) => req<Trip>("/api/trips", body("POST", t)),
  patchTrip: (id: string, t: Partial<Trip>) => req<Trip>(`/api/trips/${id}`, body("PATCH", t)),
  deleteTrip: (id: string) => req<{ ok: true }>(`/api/trips/${id}`, { method: "DELETE" }),
  rotateToken: () => req<{ token: string }>("/api/setup/token", { method: "POST" }),
  putSettings: (s: SettingsInput) => req<{ ok: true }>("/api/settings", body("PUT", s)),
  pushSubscribe: (sub: unknown) => req<{ ok: true }>("/api/push/subscribe", body("POST", sub)),
  pushUnsubscribe: (endpoint: string) => req<{ ok: true }>("/api/push/unsubscribe", body("POST", { endpoint })),
  pushTest: () => req<{ delivered: number; configured: boolean }>("/api/push/test", { method: "POST" }),

  networth: () => req<NetworthResponse>("/api/networth"),
  networthHistory: (days: number) => req<NwHeadline[]>(`/api/networth/history?days=${days}`),
  refreshNetworth: async (): Promise<NwRefreshResult> => {
    const res = await fetch("/api/networth/refresh", { method: "POST", headers: { "content-type": "application/json" } });
    if (res.status === 429) {
      const j = await res.json().catch(() => null) as { retry_after_s?: number } | null;
      throw new RefreshLimitedError(j?.retry_after_s ?? 300);
    }
    if (!res.ok) throw new Error(`${res.status}: ${res.statusText}`);
    return res.json() as Promise<NwRefreshResult>;
  },
  createNwAccount: (a: NwAccountInput) => req<NwAccountRow>("/api/nw/accounts", body("POST", a)),
  patchNwAccount: (id: string, a: Partial<NwAccountInput>) => req<NwAccountRow>(`/api/nw/accounts/${id}`, body("PATCH", a)),
  addNwBalance: (accountId: string, b: NwBalanceInput) => req<NwBalanceRow>(`/api/nw/accounts/${accountId}/balances`, body("POST", b)),
  deleteNwBalance: (id: string) => req<{ ok: true }>(`/api/nw/balances/${id}`, { method: "DELETE" }),
  createNwHolding: (h: NwHoldingInput) => req<NwHoldingRow>("/api/nw/holdings", body("POST", h)),
  patchNwHolding: (id: string, h: Partial<NwHoldingInput>) => req<NwHoldingRow>(`/api/nw/holdings/${id}`, body("PATCH", h)),
  deleteNwHolding: (id: string) => req<{ ok: true }>(`/api/nw/holdings/${id}`, { method: "DELETE" }),
  markStatementPaid: (accountId: string, statementDate: string) => req<{ account_id: string; statement_date: string; paid_at: string }>(`/api/cards/${accountId}/statement-paid`, body("POST", { statement_date: statementDate })),
  unmarkStatementPaid: (accountId: string, statementDate: string) => req<{ ok: true }>(`/api/cards/${accountId}/statement-paid`, body("DELETE", { statement_date: statementDate })),
  goals: () => req<GoalsResponse>("/api/goals"),
  goal: (id: string) => req<GoalDetail>(`/api/goals/${id}`),
  emergencySuggestion: () => req<EmergencySuggestion>("/api/goals/emergency-suggestion"),
  createGoal: (g: Partial<GoalInput> & Pick<GoalInput, "name" | "kind">) => req<GoalView>("/api/goals", body("POST", g)),
  patchGoal: (id: string, g: Partial<GoalInput> & { archived?: boolean }) => req<GoalView | { id: string; archived: true }>(`/api/goals/${id}`, body("PATCH", g)),
  archiveGoal: (id: string) => req<{ id: string; archived: true }>(`/api/goals/${id}`, { method: "DELETE" }),
  reorderGoals: (ids: string[]) => req<{ order: string[] }>("/api/goals/reorder", body("POST", { ids })),
  setGoalUnderspend: (id: string, on: boolean) => req<{ id: string; receives_underspend: boolean }>(`/api/goals/${id}/underspend`, body("POST", { on })),
  addGoalFunding: (id: string, f: GoalFundingInput) => req<{ link: GoalFundingRow; warnings: GoalWarning[] }>(`/api/goals/${id}/funding`, body("POST", f)),
  deleteGoalFunding: (linkId: string) => req<{ ok: true; warnings: GoalWarning[] }>(`/api/goal-funding/${linkId}`, { method: "DELETE" }),
  addGoalContribution: (id: string, c: { amount_sgd_minor: number; status?: "transferred" | "pledged" }) => req<GoalContribution>(`/api/goals/${id}/contributions`, body("POST", c)),
  transferPledge: (id: string) => req<GoalContribution>(`/api/goal-contributions/${id}/transfer`, { method: "POST" }),
  skipPledge: (id: string) => req<GoalContribution>(`/api/goal-contributions/${id}/skip`, { method: "POST" }),
  // Want list (v2 W)
  wants: () => req<WantsResponse>("/api/wants"),
  wantStats: () => req<WantStats>("/api/wants/stats"),
  createWant: (w: WantInput) => req<WantItem>("/api/wants", body("POST", w)),
  patchWant: (id: string, w: Partial<WantInput>) => req<WantItem>(`/api/wants/${id}`, body("PATCH", w)),
  deleteWant: (id: string) => req<{ ok: true }>(`/api/wants/${id}`, { method: "DELETE" }),
  /** 409 "confirm_early" while the wait is running: ask once, then resend with confirm_early. */
  buyWant: (id: string, confirmEarly = false) => req<{ want: WantItem; matches: WantMatch[] }>(`/api/wants/${id}/buy`, body("POST", confirmEarly ? { confirm_early: true } : {})),
  skipWant: (id: string) => req<{ want: WantItem; offer: WantSkipOffer | null }>(`/api/wants/${id}/skip`, { method: "POST" }),
  pledgeWant: (id: string, goalId: string) => req<{ ok: true; pledge_id: string }>(`/api/wants/${id}/pledge`, body("POST", { goal_id: goalId })),
  wantMatches: (id: string) => req<{ matches: WantMatch[] }>(`/api/wants/${id}/matches`),
  linkWant: (id: string, transactionId: string) => req<WantItem>(`/api/wants/${id}/link`, body("POST", { transaction_id: transactionId })),
};
