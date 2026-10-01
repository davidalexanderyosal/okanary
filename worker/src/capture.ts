import { convertMinor, monthProgress, normalizeMerchant, purchaseNudgeBody, sgtMonth, type Transaction } from "@okanary/core";
import { categorise } from "./categorise";
import type { Deps } from "./deps";
import { loadSummaryRows } from "./db";
import { getSgdRate } from "./fx";
import { sendPushToAll } from "./push";
import type { Env } from "./env";
import { getSetting } from "./settings";
import { nowIso, ulid } from "./util";
import { summarizeMonth } from "@okanary/core";

export interface CaptureInput {
  source: "applepay" | "email" | "import";
  occurred_at: string;
  amount_minor: number;
  currency: string;
  /** If the bank stated the SGD amount, pass it with fx_source 'bank'. */
  amount_sgd_minor?: number;
  merchant_raw: string;
  account_id: string | null;
  status: Transaction["status"];
  raw_id?: string;
}

/**
 * Shared capture pipeline (spec §4): normalise merchant -> FX -> categorise -> save. Returns the saved row.
 * Dedup/merge (Phase 3) hooks in before the insert.
 */
export async function captureTransaction(env: Env, deps: Deps, input: CaptureInput): Promise<Transaction> {
  const merchant = normalizeMerchant(input.merchant_raw || "");
  let sgd = input.amount_minor;
  let fxRate: number | null = null;
  let fxSource: Transaction["fx_source"] = "same";
  let status = input.status;
  let note: string | null = null;

  if (input.currency !== "SGD") {
    if (input.amount_sgd_minor != null) {
      sgd = input.amount_sgd_minor;
      fxSource = "bank";
      fxRate = input.amount_minor > 0 ? input.amount_sgd_minor / input.amount_minor : null;
    } else {
      const r = await getSgdRate(env.DB, input.currency, input.occurred_at, deps.fetch);
      if (r) {
        sgd = convertMinor(input.amount_minor, input.currency, "SGD", r.rate);
        fxRate = r.rate;
        fxSource = "ecb";
      } else {
        // D-13: no rate obtainable -> keep the record, flag it for review, SGD amount unknown (0) until the user fixes it.
        sgd = 0;
        fxSource = null;
        status = "needs_review";
        note = "FX rate unavailable: set the SGD amount";
      }
    }
  }

  const cat = await categorise(env.DB, deps.ai, merchant);
  const id = ulid();
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO transactions (id, occurred_at, account_id, amount_minor, currency, amount_sgd_minor, fx_rate, fx_source,
       merchant_raw, merchant, category_id, category_source, status, source, is_refund, is_reimbursable, is_excluded, note, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,?,?,?,?)`,
  )
    .bind(id, input.occurred_at, input.account_id, input.amount_minor, input.currency, sgd, fxRate, fxSource,
      input.merchant_raw || null, merchant || null, cat.category_id, cat.source, status, input.source, cat.set_excluded ? 1 : 0, note, now, now)
    .run();
  if (input.raw_id) await env.DB.prepare("UPDATE raw_ingest SET transaction_id = ?, parse_status = 'ok' WHERE id = ?").bind(id, input.raw_id).run();
  return (await env.DB.prepare("SELECT * FROM transactions WHERE id = ?").bind(id).first<Transaction>())!;
}

/** Push "S$14.50 · Ya Kun · Coffee — Lifestyle S$642 (day 14/31)" after an auto-captured transaction (spec §7). */
export async function pushPurchaseNudge(env: Env, deps: Deps, t: Transaction): Promise<void> {
  if ((await getSetting(env.DB, "push_post_purchase")) === "0") return;
  const month = sgtMonth(t.occurred_at);
  const rows = await loadSummaryRows(env.DB, month);
  const s = summarizeMonth(rows, month, deps.now());
  const prog = monthProgress(deps.now());
  const lifestyle = s.byGroup.find((g) => g.id === "lifestyle")?.spent ?? 0;
  const cat = t.category_id ? (await env.DB.prepare("SELECT name FROM categories WHERE id = ?").bind(t.category_id).first<{ name: string }>())?.name ?? null : null;
  const body = purchaseNudgeBody({
    amountMinor: t.amount_minor, currency: t.currency, merchant: t.merchant, categoryName: cat,
    lifestyleSpentSgd: lifestyle, lifestyleBudgetSgd: await lifestyleBudget(env.DB, month),
    day: prog.day, daysInMonth: prog.daysInMonth,
  });
  await sendPushToAll(env, deps, { title: "Okanary", body, url: `/transactions?edit=${t.id}`, tag: "purchase" });
}

/** Phase 4 fills this from the budgets table; returns the Lifestyle group budget for the month if one exists. */
export async function lifestyleBudget(db: D1Database, month: string): Promise<number | null> {
  const r = await db
    .prepare("SELECT monthly_amount_sgd_minor AS v FROM budgets WHERE scope = 'group' AND ref_id = 'lifestyle' AND effective_from <= ? ORDER BY effective_from DESC LIMIT 1")
    .bind(month)
    .first<{ v: number }>();
  return r?.v ?? null;
}
