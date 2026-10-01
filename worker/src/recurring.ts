import { detectMonthly, isSpend, type RecurringCandidate, type SummaryRow } from "@okanary/core";
import type { Deps } from "./deps";
import { TXN_WITH_GROUP_SQL } from "./db";
import type { Env } from "./env";
import { ulid } from "./util";

interface RecurringRow { id: string; merchant: string; active: number; confirmed_by_user: number }

/**
 * Daily recurring detection (spec §3.2, §5): same merchant, ~monthly, similar amount, 3+ charges, still active.
 * New finds are inserted unconfirmed; ones the user dismissed (active=0) are never resurrected; confirmed ones keep being
 * refreshed (amount / next expected date).
 */
export async function runRecurringDetection(env: Env, deps: Deps): Promise<{ added: number; updated: number }> {
  const since = new Date(deps.now().getTime() - 400 * 86400_000).toISOString();
  const rows = (await env.DB.prepare(`${TXN_WITH_GROUP_SQL} WHERE t.occurred_at >= ? AND t.merchant IS NOT NULL`).bind(since).all<SummaryRow>()).results;
  // trips only hide spend from monthly views; a subscription charged while travelling is still a subscription
  const spend = rows.filter((r) => !r.is_refund && isSpend(r, { ignoreTripExclusion: true })).map((r) => ({ merchant: r.merchant ?? null, occurred_at: r.occurred_at, amount_sgd_minor: r.amount_sgd_minor, category_id: r.category_id }));
  const found: RecurringCandidate[] = detectMonthly(spend, deps.now());
  const existing = (await env.DB.prepare("SELECT id, merchant, active, confirmed_by_user FROM recurring").all<RecurringRow>()).results;
  let added = 0, updated = 0;
  for (const c of found) {
    const ex = existing.find((e) => e.merchant === c.merchant);
    if (ex && !ex.active) continue; // dismissed
    let id: string;
    if (ex) {
      id = ex.id;
      await env.DB.prepare("UPDATE recurring SET expected_amount_sgd_minor = ?, next_expected = ?, cadence = 'monthly', category_id = COALESCE(category_id, ?) WHERE id = ?").bind(c.expected_amount_sgd_minor, c.next_expected, c.category_id, id).run();
      updated++;
    } else {
      id = ulid();
      await env.DB.prepare("INSERT INTO recurring (id, merchant, expected_amount_sgd_minor, cadence, next_expected, category_id, active, confirmed_by_user) VALUES (?,?,?,?,?,?,1,0)")
        .bind(id, c.merchant, c.expected_amount_sgd_minor, "monthly", c.next_expected, c.category_id).run();
      added++;
    }
    await env.DB.prepare("UPDATE transactions SET recurring_id = ? WHERE merchant = ? AND recurring_id IS NULL AND status != 'void'").bind(id, c.merchant).run();
  }
  return { added, updated };
}
