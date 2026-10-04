import { bestCandidate, convertMinor, monthProgress, normalizeMerchant, purchaseNudgeBody, sgtMonth, summarizeMonth, type DedupTxn, type Transaction } from "@okanary/core";
import { categorise, type Categorisation } from "./categorise";
import type { Deps } from "./deps";
import { loadSummaryRows } from "./db";
import type { Env } from "./env";
import { loadWeekAllowance } from "./allowance";
import { getSgdRate } from "./fx";
import { sendPushToAll } from "./push";
import { getSetting } from "./settings";
import { tripCovering } from "./trips";
import { nowIso, ulid } from "./util";

export interface CaptureInput {
  source: "applepay" | "email" | "import";
  occurred_at: string;
  amount_minor: number;
  currency: string;
  /** If the bank stated the SGD amount, pass it (fx_source 'bank'). */
  amount_sgd_minor?: number;
  merchant_raw: string;
  account_id: string | null;
  status: Transaction["status"];
  raw_id?: string;
  is_refund?: boolean;
}

export interface CaptureResult {
  txn: Transaction;
  /** True when this capture was folded into an existing Apple Pay / email record instead of creating a new one. */
  merged: boolean;
  /** Set when a *possible* (uncertain) duplicate was found: a Review card was created, nothing was merged. */
  duplicateCandidateId?: string;
}

interface Money { sgd: number; fxRate: number | null; fxSource: Transaction["fx_source"]; status: Transaction["status"]; note: string | null }

async function resolveMoney(env: Env, deps: Deps, input: CaptureInput): Promise<Money> {
  if (input.currency === "SGD") return { sgd: input.amount_minor, fxRate: null, fxSource: "same", status: input.status, note: null };
  if (input.amount_sgd_minor != null) {
    return { sgd: input.amount_sgd_minor, fxRate: input.amount_minor > 0 ? input.amount_sgd_minor / input.amount_minor : null, fxSource: "bank", status: input.status, note: null };
  }
  const r = await getSgdRate(env.DB, input.currency, input.occurred_at, deps.fetch);
  if (r) return { sgd: convertMinor(input.amount_minor, input.currency, "SGD", r.rate), fxRate: r.rate, fxSource: "ecb", status: input.status, note: null };
  // D-13: no rate obtainable -> keep the record, flag it for review, SGD amount unknown (0) until the user fixes it.
  return { sgd: 0, fxRate: null, fxSource: null, status: "needs_review", note: "FX rate unavailable: set the SGD amount" };
}

/** Existing Apple Pay / email records that could be the same purchase as `incoming` (not already linked to this source). */
async function findCandidates(db: D1Database, input: CaptureInput, merchant: string): Promise<(DedupTxn & { status: string })[]> {
  const t = Date.parse(input.occurred_at);
  const lo = new Date(t - 31 * 60_000).toISOString();
  const hi = new Date(t + 31 * 60_000).toISOString();
  const other = input.source === "applepay" ? "email" : "applepay";
  const { results } = await db
    .prepare(
      `SELECT t.id, t.source, t.account_id, t.currency, t.amount_minor, t.occurred_at, t.merchant, t.status
       FROM transactions t
       WHERE t.status != 'void' AND t.source = ?1 AND t.currency = ?2 AND t.occurred_at BETWEEN ?3 AND ?4
         AND NOT EXISTS (SELECT 1 FROM raw_ingest r WHERE r.transaction_id = t.id AND r.source LIKE ?5)`,
    )
    .bind(other, input.currency, lo, hi, `${input.source}%`)
    .all<DedupTxn & { status: string }>();
  void merchant;
  return results;
}

/**
 * Shared capture pipeline (spec §4): normalise merchant -> FX -> dedup/merge -> categorise -> save.
 *
 * Merge rule (spec §4.3): keep the EMAIL's amount (closer to the bank's record) and the APPLE PAY timestamp, status = confirmed,
 * both raw records linked to the one transaction. A merged capture creates no new row (and therefore no second notification).
 */
export async function captureTransaction(env: Env, deps: Deps, input: CaptureInput): Promise<CaptureResult> {
  const merchant = normalizeMerchant(input.merchant_raw || "");
  const money = await resolveMoney(env, deps, input);
  const cat = await categorise(env.DB, deps.ai, merchant);

  const incoming: DedupTxn = { id: "incoming", source: input.source === "email" ? "email" : "applepay", account_id: input.account_id, currency: input.currency, amount_minor: input.amount_minor, occurred_at: input.occurred_at, merchant };
  const found = input.source === "applepay" || input.source === "email" ? bestCandidate(incoming, await findCandidates(env.DB, input, merchant)) : null;

  if (found?.strength === "match") {
    const merged = await mergeIntoExisting(env.DB, found.candidate.id, input, money, cat);
    return { txn: merged, merged: true };
  }

  const id = ulid();
  const now = nowIso();
  const tripId = (await tripCovering(env.DB, input.occurred_at))?.id ?? null;
  await env.DB.prepare(
    `INSERT INTO transactions (id, occurred_at, account_id, amount_minor, currency, amount_sgd_minor, fx_rate, fx_source,
       merchant_raw, merchant, category_id, category_source, status, source, is_refund, is_reimbursable, is_excluded, note, trip_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?)`,
  )
    .bind(id, input.occurred_at, input.account_id, input.amount_minor, input.currency, money.sgd, money.fxRate, money.fxSource,
      input.merchant_raw || null, merchant || null, cat.category_id, cat.source, money.status, input.source, input.is_refund ? 1 : 0, cat.set_excluded ? 1 : 0, money.note, tripId, now, now)
    .run();
  if (input.raw_id) await env.DB.prepare("UPDATE raw_ingest SET transaction_id = ?, parse_status = 'ok' WHERE id = ?").bind(id, input.raw_id).run();

  let duplicateCandidateId: string | undefined;
  if (found?.strength === "maybe") {
    duplicateCandidateId = ulid();
    await env.DB.prepare("INSERT INTO duplicate_candidates (id, txn_id, other_id, created_at) VALUES (?,?,?,?)").bind(duplicateCandidateId, id, found.candidate.id, now).run();
  }
  const txn = (await env.DB.prepare("SELECT * FROM transactions WHERE id = ?").bind(id).first<Transaction>())!;
  return { txn, merged: false, duplicateCandidateId };
}

async function mergeIntoExisting(db: D1Database, existingId: string, input: CaptureInput, money: Money, cat: Categorisation): Promise<Transaction> {
  const e = (await db.prepare("SELECT * FROM transactions WHERE id = ?").bind(existingId).first<Transaction>())!;
  const now = nowIso();
  if (input.source === "email") {
    // existing = Apple Pay record: take the bank's amount, keep Apple Pay's timestamp/category/merchant.
    await db.prepare(
      `UPDATE transactions SET amount_minor=?, currency=?, amount_sgd_minor=?, fx_rate=?, fx_source=?, account_id=COALESCE(account_id, ?), status='confirmed', updated_at=? WHERE id=?`,
    ).bind(input.amount_minor, input.currency, money.sgd, money.fxRate, money.fxSource, input.account_id, now, existingId).run();
  } else {
    // existing = email record: keep the bank's amount, take Apple Pay's timestamp; fill gaps from this capture.
    await db.prepare(
      `UPDATE transactions SET occurred_at=?, account_id=COALESCE(account_id, ?),
         category_id=COALESCE(category_id, ?), category_source=CASE WHEN category_id IS NULL THEN ? ELSE category_source END,
         status='confirmed', updated_at=? WHERE id=?`,
    ).bind(input.occurred_at, input.account_id, cat.category_id, cat.source, now, existingId).run();
  }
  if (input.raw_id) await db.prepare("UPDATE raw_ingest SET transaction_id = ?, parse_status = 'ok' WHERE id = ?").bind(existingId, input.raw_id).run();
  void e;
  return (await db.prepare("SELECT * FROM transactions WHERE id = ?").bind(existingId).first<Transaction>())!;
}

/**
 * User-confirmed merge of a "Possible duplicate" pair. The Apple Pay record survives (keeps its id, category and edits);
 * it takes the email's amount, and the email row is removed after its raw records are re-pointed.
 */
export async function mergeDuplicatePair(db: D1Database, candidateId: string): Promise<Transaction | null> {
  const c = await db.prepare("SELECT * FROM duplicate_candidates WHERE id = ? AND resolved = 0").bind(candidateId).first<{ txn_id: string; other_id: string }>();
  if (!c) return null;
  const rows = (await db.prepare("SELECT * FROM transactions WHERE id IN (?, ?)").bind(c.txn_id, c.other_id).all<Transaction>()).results;
  const apple = rows.find((r) => r.source === "applepay");
  const mail = rows.find((r) => r.source === "email");
  if (!apple || !mail) return null;
  const now = nowIso();
  await db.batch([
    db.prepare(
      `UPDATE transactions SET amount_minor=?, currency=?, amount_sgd_minor=?, fx_rate=?, fx_source=?, account_id=COALESCE(account_id, ?),
         category_id=COALESCE(category_id, ?), category_source=CASE WHEN category_id IS NULL THEN ? ELSE category_source END, status='confirmed', updated_at=? WHERE id=?`,
    ).bind(mail.amount_minor, mail.currency, mail.amount_sgd_minor, mail.fx_rate, mail.fx_source, mail.account_id, mail.category_id, mail.category_source, now, apple.id),
    db.prepare("UPDATE raw_ingest SET transaction_id = ? WHERE transaction_id = ?").bind(apple.id, mail.id),
    db.prepare("UPDATE duplicate_candidates SET resolved = 1 WHERE id = ?").bind(candidateId),
    db.prepare("DELETE FROM transactions WHERE id = ?").bind(mail.id),
  ]);
  return (await db.prepare("SELECT * FROM transactions WHERE id = ?").bind(apple.id).first<Transaction>()) ?? null;
}

/** Text of the post-purchase push: "S$14.50 · Ya Kun · Coffee — S$96 left this week" (v2 A), or the month form when there is no allowance. */
export async function buildPurchaseNudgeBody(env: Env, deps: Deps, t: Transaction): Promise<string> {
  const month = sgtMonth(t.occurred_at);
  const rows = await loadSummaryRows(env.DB, month);
  const s = summarizeMonth(rows, month, deps.now());
  const prog = monthProgress(deps.now());
  const lifestyle = s.byGroup.find((g) => g.id === "lifestyle")?.spent ?? 0;
  const cat = t.category_id ? (await env.DB.prepare("SELECT name FROM categories WHERE id = ?").bind(t.category_id).first<{ name: string }>())?.name ?? null : null;
  const wk = await loadWeekAllowance(env.DB, deps.now());
  return purchaseNudgeBody({
    amountMinor: t.amount_minor, currency: t.currency, merchant: t.merchant, categoryName: cat,
    lifestyleSpentSgd: lifestyle, lifestyleBudgetSgd: await lifestyleBudget(env.DB, month),
    day: prog.day, daysInMonth: prog.daysInMonth,
    weekLeftSgd: wk.allowance.hasAllowance ? wk.allowance.total - wk.spent : null,
  });
}

/** Post-purchase push after a newly auto-captured transaction (spec §7). Exempt from the nudge gate (limit, quiet hours). */
export async function pushPurchaseNudge(env: Env, deps: Deps, t: Transaction): Promise<void> {
  if ((await getSetting(env.DB, "push_post_purchase")) === "0") return;
  const body = await buildPurchaseNudgeBody(env, deps, t);
  await sendPushToAll(env, deps, { title: "Okanary", body, url: `/transactions?edit=${t.id}`, tag: "purchase" });
}

/** Lifestyle group budget for the month if one exists (budgets UI arrives in Phase 4). */
export async function lifestyleBudget(db: D1Database, month: string): Promise<number | null> {
  const r = await db
    .prepare("SELECT monthly_amount_sgd_minor AS v FROM budgets WHERE scope = 'group' AND ref_id = 'lifestyle' AND effective_from <= ? ORDER BY effective_from DESC LIMIT 1")
    .bind(month)
    .first<{ v: number }>();
  return r?.v ?? null;
}
