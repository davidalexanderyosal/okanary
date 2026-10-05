import { addMonths, monthRangeUtc, resolveBudgets, summarizeMonth, type BudgetRow, type MonthSummary, type SummaryRow, type Transaction } from "@okanary/core";
import { ulid } from "./util";

/** Columns every spend calculation needs: the txn plus its category's group and counts_as_spend. */
export const TXN_WITH_GROUP_SQL = `
  SELECT t.*, c.group_id AS group_id, g.counts_as_spend AS group_counts_as_spend, COALESCE(tr.exclude_from_monthly, 0) AS trip_excluded
  FROM transactions t
  LEFT JOIN categories c ON c.id = t.category_id
  LEFT JOIN category_groups g ON g.id = c.group_id
  LEFT JOIN trips tr ON tr.id = t.trip_id`;

/**
 * Review inbox predicate (spec §7.3): anything not void/excluded that has no category, carries only an AI *suggestion*,
 * or is explicitly 'needs_review'. Phase 3 adds possible-duplicate cards on top.
 */
export const REVIEW_WHERE = `t.status != 'void' AND t.is_excluded = 0 AND (t.status = 'needs_review' OR t.category_id IS NULL OR t.category_source = 'ai')`;

/**
 * raw_ingest rows that belong in the Review inbox's "failed" list: unparsed mail, plus service receipts the LLM read
 * (parse_status 'review', source 'email:receipt') that wait for a decision on the Subscriptions screen (v2 S).
 */
export const RAW_REVIEW_WHERE = `((parse_status = 'failed' AND transaction_id IS NULL) OR (parse_status = 'review' AND source = 'email:receipt'))`;

/** Rows covering [start of previous month, end of month): all that summarizeMonth needs. */
export async function loadSummaryRows(db: D1Database, month: string): Promise<SummaryRow[]> {
  const start = monthRangeUtc(addMonths(month, -1)).start;
  const end = monthRangeUtc(month).end;
  const { results } = await db
    .prepare(`${TXN_WITH_GROUP_SQL} WHERE t.occurred_at >= ?1 AND t.occurred_at < ?2`)
    .bind(start, end)
    .all<SummaryRow>();
  return results;
}

/** Rows for months first..last (inclusive), for multi-month trends. */
export async function loadRowsBetween(db: D1Database, firstMonth: string, lastMonth: string): Promise<SummaryRow[]> {
  const { results } = await db
    .prepare(`${TXN_WITH_GROUP_SQL} WHERE t.occurred_at >= ?1 AND t.occurred_at < ?2`)
    .bind(monthRangeUtc(firstMonth).start, monthRangeUtc(lastMonth).end)
    .all<SummaryRow>();
  return results;
}

export async function monthSummary(db: D1Database, month: string, now: Date = new Date()): Promise<MonthSummary & { reviewCount: number; budgets: BudgetRow[] }> {
  const rows = await loadSummaryRows(db, month);
  const summary = summarizeMonth(rows, month, now);
  const rc = await db.prepare(`SELECT COUNT(*) AS n FROM transactions t WHERE ${REVIEW_WHERE}`).first<{ n: number }>();
  const failed = await db.prepare(`SELECT COUNT(*) AS n FROM raw_ingest WHERE ${RAW_REVIEW_WHERE}`).first<{ n: number }>();
  const dups = await db.prepare(`SELECT COUNT(*) AS n FROM duplicate_candidates WHERE resolved = 0`).first<{ n: number }>();
  const budgets = resolveBudgets((await db.prepare("SELECT scope, ref_id, monthly_amount_sgd_minor, effective_from FROM budgets").all<BudgetRow>()).results, month);
  return { ...summary, reviewCount: (rc?.n ?? 0) + (failed?.n ?? 0) + (dups?.n ?? 0), budgets };
}

export async function loadBudgetRows(db: D1Database): Promise<BudgetRow[]> {
  return (await db.prepare("SELECT scope, ref_id, monthly_amount_sgd_minor, effective_from FROM budgets").all<BudgetRow>()).results;
}

export async function getTransaction(db: D1Database, id: string): Promise<Transaction | null> {
  return db.prepare(`SELECT * FROM transactions WHERE id = ?`).bind(id).first<Transaction>();
}

/** Insert or update the budget row for (scope, ref, effective_from month). Amount 0 clears the budget from that month on. */
export async function upsertBudget(db: D1Database, scope: string, ref: string, month: string, amount: number): Promise<void> {
  const existing = await db.prepare("SELECT id FROM budgets WHERE scope = ? AND ref_id = ? AND effective_from = ?").bind(scope, ref, month).first<{ id: string }>();
  if (existing) await db.prepare("UPDATE budgets SET monthly_amount_sgd_minor = ? WHERE id = ?").bind(amount, existing.id).run();
  else await db.prepare("INSERT INTO budgets (id, scope, ref_id, monthly_amount_sgd_minor, effective_from) VALUES (?,?,?,?,?)").bind(ulid(), scope, ref, amount, month).run();
}
