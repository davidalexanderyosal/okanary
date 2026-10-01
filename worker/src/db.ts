import { addMonths, monthRangeUtc, summarizeMonth, type MonthSummary, type SummaryRow, type Transaction } from "@okanary/core";

/** Columns every spend calculation needs: the txn plus its category's group and counts_as_spend. */
export const TXN_WITH_GROUP_SQL = `
  SELECT t.*, c.group_id AS group_id, g.counts_as_spend AS group_counts_as_spend
  FROM transactions t
  LEFT JOIN categories c ON c.id = t.category_id
  LEFT JOIN category_groups g ON g.id = c.group_id`;

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

export async function monthSummary(db: D1Database, month: string, now: Date = new Date()): Promise<MonthSummary & { reviewCount: number }> {
  const rows = await loadSummaryRows(db, month);
  const summary = summarizeMonth(rows, month, now);
  const rc = await db
    .prepare(`SELECT COUNT(*) AS n FROM transactions WHERE status != 'void' AND (status = 'needs_review' OR category_id IS NULL)`)
    .first<{ n: number }>();
  return { ...summary, reviewCount: rc?.n ?? 0 };
}

export async function getTransaction(db: D1Database, id: string): Promise<Transaction | null> {
  return db.prepare(`SELECT * FROM transactions WHERE id = ?`).bind(id).first<Transaction>();
}
