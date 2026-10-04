import { addDays, chargeMatches, findRule, normalizeMerchant, parseStatement, reconcile, sgtDate, sgtLocalToUtc, type ExistingTxn, type MerchantRule, type ParsedStatement, type ReconcilePlan, type StatementRow } from "@okanary/core";
import type { Deps } from "./deps";
import type { Env } from "./env";
import { tripForDate } from "./trips";
import { onChargeRecorded } from "./subscriptions";
import { nowIso, ulid } from "./util";

export const MAX_STATEMENT_ROWS = 300;

export interface ImportOutcome {
  parsed: ParsedStatement;
  plan: ReconcilePlan;
  existingInWindow: number;
  applied?: { corrected: number; confirmed: number; added: number };
}

interface ExistingRow extends ExistingTxn { account_id: string | null; fx_source: string | null }

/**
 * Reconcile a pasted/uploaded statement against one card's records (spec §3.2): match by amount/date/merchant, correct the SGD
 * amount to the final billed one (fx_source='statement'), add what's missing as source='import', ignore card payments.
 * Re-importing the same statement is a no-op: everything matches itself. `commit=false` only previews.
 */
export async function importStatement(env: Env, deps: Deps, input: { account_id: string; text: string; commit: boolean }): Promise<ImportOutcome> {
  const today = sgtDate(deps.now());
  const parsed = parseStatement(input.text, today);
  if (parsed.rows.length > MAX_STATEMENT_ROWS) throw new Error(`too many rows (max ${MAX_STATEMENT_ROWS}); split the statement`);
  if (parsed.rows.length === 0) return { parsed, plan: { matched: [], toAdd: [], payments: [], notOnStatement: [] }, existingInWindow: 0, ...(input.commit ? { applied: { corrected: 0, confirmed: 0, added: 0 } } : {}) };

  const dates = parsed.rows.map((r) => r.date).sort();
  const lo = sgtLocalToUtc(addDays(dates[0]!, -5), "00:00");
  const hi = sgtLocalToUtc(addDays(dates[dates.length - 1]!, 6), "00:00");
  const existing = (
    await env.DB.prepare("SELECT id, occurred_at, amount_minor, currency, amount_sgd_minor, merchant, is_refund, status, account_id, fx_source FROM transactions WHERE (account_id = ?1 OR account_id IS NULL) AND occurred_at >= ?2 AND occurred_at < ?3")
      .bind(input.account_id, lo, hi).all<ExistingRow>()
  ).results;
  const plan = reconcile(parsed.rows, existing);
  const outcome: ImportOutcome = { parsed, plan, existingInWindow: existing.length };
  if (!input.commit) return outcome;

  const now = nowIso();
  const stmts: D1PreparedStatement[] = [];
  let corrected = 0, confirmed = 0;
  const byId = new Map(existing.map((e) => [e.id, e]));
  for (const m of plan.matched) {
    const t = byId.get(m.txnId)!;
    if (m.correctSgdTo !== undefined) {
      const sgdCur = t.currency === "SGD";
      stmts.push(env.DB.prepare(
        `UPDATE transactions SET amount_sgd_minor = ?1, amount_minor = CASE WHEN currency = 'SGD' THEN ?1 ELSE amount_minor END,
           fx_rate = CASE WHEN currency = 'SGD' THEN fx_rate ELSE CAST(?1 AS REAL) / amount_minor END, fx_source = ?2, status = 'confirmed',
           account_id = COALESCE(account_id, ?3), updated_at = ?4 WHERE id = ?5`,
      ).bind(m.correctSgdTo, sgdCur ? "same" : "statement", input.account_id, now, m.txnId));
      corrected++;
    } else if (t.status !== "confirmed" || t.account_id === null) {
      stmts.push(env.DB.prepare("UPDATE transactions SET status = 'confirmed', account_id = COALESCE(account_id, ?1), updated_at = ?2 WHERE id = ?3").bind(input.account_id, now, m.txnId));
      confirmed++;
    }
  }

  // Missing lines -> new records, categorised from rules/history only (no per-row AI: keeps an import to a handful of queries).
  const rules = (await env.DB.prepare("SELECT id, match_type, pattern, category_id, set_excluded, priority FROM merchant_rules").all<MerchantRule>()).results;
  const hist = new Map<string, string>();
  for (const h of (await env.DB.prepare("SELECT merchant, category_id FROM transactions WHERE category_id IS NOT NULL AND merchant IS NOT NULL AND category_source IN ('user','rule','history') ORDER BY occurred_at DESC LIMIT 2000").all<{ merchant: string; category_id: string }>()).results) {
    if (!hist.has(h.merchant)) hist.set(h.merchant, h.category_id);
  }
  const trips = (await env.DB.prepare("SELECT id, start_date, end_date FROM trips").all<{ id: string; start_date: string | null; end_date: string | null }>()).results;
  const added: { id: string; merchant: string; occurred_at: string; amount_minor: number; is_refund: number }[] = [];
  for (const r of plan.toAdd) {
    const id = ulid();
    stmts.push(insertImported(env, id, r, input.account_id, rules, hist, trips, now));
    added.push({ id, merchant: normalizeMerchant(r.description), occurred_at: sgtLocalToUtc(r.date, "12:00"), amount_minor: Math.abs(r.amount_minor), is_refund: r.amount_minor < 0 ? 1 : 0 });
  }

  const rawId = ulid();
  stmts.push(env.DB.prepare("INSERT INTO raw_ingest (id, source, received_at, payload, parse_status) VALUES (?,?,?,?,'ok')").bind(rawId, "import", now, input.text.slice(0, 200_000)));
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  // v2 S: recurring charges mostly arrive through statements (no bank alert), so imported lines go through the subscription
  // charge hook too. Live patterns are loaded once; only lines that match one cost extra queries.
  const patterns = (await env.DB.prepare("SELECT merchant_pattern FROM subscriptions WHERE status IN ('active','cancel_intended','trial') AND merchant_pattern IS NOT NULL").all<{ merchant_pattern: string }>()).results.map((x) => x.merchant_pattern);
  for (const a of added) {
    if (a.is_refund || !patterns.some((p) => chargeMatches(a.merchant, p))) continue;
    await onChargeRecorded(env, deps, { id: a.id, merchant: a.merchant, occurred_at: a.occurred_at, amount_minor: a.amount_minor, currency: "SGD", amount_sgd_minor: a.amount_minor, is_refund: 0, status: "confirmed" });
  }
  outcome.applied = { corrected, confirmed, added: plan.toAdd.length };
  return outcome;
}

function insertImported(env: Env, id: string, r: StatementRow, accountId: string, rules: MerchantRule[], hist: Map<string, string>, trips: { id: string; start_date: string | null; end_date: string | null }[], now: string): D1PreparedStatement {
  const merchant = normalizeMerchant(r.description);
  const rule = findRule(rules, merchant);
  const categoryId = rule?.category_id ?? hist.get(merchant) ?? null;
  const source = rule ? "rule" : hist.has(merchant) ? "history" : null;
  const amt = Math.abs(r.amount_minor);
  return env.DB.prepare(
    `INSERT INTO transactions (id, occurred_at, account_id, amount_minor, currency, amount_sgd_minor, fx_rate, fx_source, merchant_raw, merchant,
       category_id, category_source, status, source, is_refund, is_reimbursable, is_excluded, note, trip_id, created_at, updated_at)
     VALUES (?,?,?,?, 'SGD', ?, NULL, 'statement', ?,?,?,?, 'confirmed', 'import', ?, 0, ?, 'Imported from statement', ?, ?, ?)`,
  ).bind(id, sgtLocalToUtc(r.date, "12:00"), accountId, amt, amt, r.description, merchant, categoryId, source, r.amount_minor < 0 ? 1 : 0, rule?.set_excluded ? 1 : 0, tripForDate(trips, r.date), now, now);
}
