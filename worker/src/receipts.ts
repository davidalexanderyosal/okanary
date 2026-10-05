import {
  CATALOGUE, addCycle, convertMinor, findExistingSubscription, matchAppleReceipt, sgtDate,
  type Cycle,
} from "@okanary/core";
import type { Deps } from "./deps";
import type { Env } from "./env";
import { getSgdRate } from "./fx";
import { parseAppleReceipt, type AppleReceiptItem, type ParsedAppleReceipt } from "./parsers/apple-receipt";
import { extractReceiptWithAi } from "./parsers/receipt-ai";
import { addSubscriptionEvent, loadAllSubscriptions } from "./subscriptions";
import { ulid } from "./util";

/**
 * Receipt emails (v2 S, "Ways a subscription gets in" 3 and 4). Apple receipts label the APPLE.COM/BILL card charge and
 * learn the subscription; generic service receipts go through the LLM and land in Review as a candidate. Never pushes.
 * The Apple parser is UNVERIFIED (synthetic fixtures only), see parsers/apple-receipt.ts.
 */

export type ReceiptOutcome =
  | { action: "receipt"; source: "apple"; transactionId: string | null; subscriptionIds: string[] }
  | { action: "receipt"; source: "receipt"; subscriptionId: string | null }
  | { action: "failed"; error: string };

const APPLE_PATTERN = "APPLE.COM/BILL";
const DAY = 86400_000;
const REMATCH_DAYS = 10;

/** SGD value of an amount: same currency, else the cached/ECB rate; 0 (= unknown) when no rate is obtainable. */
async function sgdOf(env: Env, deps: Deps, amountMinor: number, currency: string, at: Date | string): Promise<number> {
  if (currency === "SGD") return amountMinor;
  const r = await getSgdRate(env.DB, currency, at, deps.fetch);
  return r ? convertMinor(amountMinor, currency, "SGD", r.rate) : 0;
}

// ---------------------------------------------------------------- Apple

const catalogueNames = CATALOGUE.filter((c) => c.patterns.length > 0).map((c) => c.name.toLowerCase());
/** An item is a subscription when the receipt gives renewal info / a cycle, or its name is a catalogue service (iCloud+...). */
export const looksLikeSubscription = (i: AppleReceiptItem): boolean =>
  !!(i.renews || i.cycle) || catalogueNames.some((n) => i.name.toLowerCase().includes(n));

interface CandidateTxn {
  id: string; merchant: string | null; amount_minor: number; currency: string; amount_sgd_minor: number; occurred_at: string; note: string | null; recurring_id: string | null;
}

/** The APPLE.COM/BILL card charge for this receipt (core rule: same amount, ±3 days), not already claimed by another receipt. */
async function findAppleCharge(env: Env, receipt: ParsedAppleReceipt): Promise<CandidateTxn | null> {
  const at = Date.parse(receipt.date);
  const rows = (await env.DB.prepare(
    `SELECT id, merchant, amount_minor, currency, amount_sgd_minor, occurred_at, note, recurring_id FROM transactions
     WHERE status != 'void' AND is_refund = 0 AND merchant LIKE 'APPLE%' AND occurred_at BETWEEN ?1 AND ?2
       AND id NOT IN (SELECT transaction_id FROM raw_ingest WHERE source = 'email:apple' AND transaction_id IS NOT NULL)`,
  ).bind(new Date(at - 3 * DAY).toISOString(), new Date(at + 3 * DAY).toISOString()).all<CandidateTxn>()).results;
  return matchAppleReceipt({ amount_minor: receipt.total_minor, currency: receipt.currency, date: receipt.date }, rows);
}

/** Find (case-insensitive name, or core's findExistingSubscription) or create the subscription for one receipt item. Null when it was dismissed. */
async function ensureAppleSubscription(env: Env, deps: Deps, receipt: ParsedAppleReceipt, item: AppleReceiptItem): Promise<string | null> {
  const day = sgtDate(receipt.date);
  const amount = item.amount_minor ?? (receipt.items.length === 1 ? receipt.total_minor : null);
  const sgd = amount != null ? await sgdOf(env, deps, amount, receipt.currency, receipt.date) : 0;
  const lname = item.name.trim().toLowerCase();
  const all = await loadAllSubscriptions(env.DB);
  const near = (s: { expected_sgd_minor: number }) => sgd <= 0 || Math.abs(s.expected_sgd_minor - sgd) <= Math.max(100, Math.floor(s.expected_sgd_minor * 0.15));
  // same name; else core's rule; else one name inside the other ("iCloud+" vs "iCloud+ with 200 GB storage") at a similar price
  const find = (list: typeof all) =>
    list.find((s) => s.name.trim().toLowerCase() === lname)
    ?? findExistingSubscription(list, { merchant: item.name, expected_sgd_minor: sgd })
    ?? list.find((s) => { const n = s.name.trim().toLowerCase(); return n.length >= 3 && (lname.includes(n) || n.includes(lname)) && near(s); })
    ?? null;

  const ex = find(all.filter((s) => s.status !== "dismissed" && s.status !== "cancelled"));
  if (ex) {
    if (!ex.merchant_pattern) await env.DB.prepare("UPDATE subscriptions SET merchant_pattern = ? WHERE id = ?").bind(APPLE_PATTERN, ex.id).run();
    return ex.id;
  }
  if (find(all.filter((s) => s.status === "dismissed"))) return null; // "Not one" is never resurrected

  const cycle: Cycle = item.cycle ?? "monthly";
  const id = ulid(deps.now().getTime());
  await env.DB.prepare(
    `INSERT INTO subscriptions (id, name, amount_minor, currency, cycle, next_renewal, category_id, source, status, merchant_pattern, expected_sgd_minor, created_at)
     VALUES (?,?,?,?,?,?,'subscriptions','apple_receipt','active',?,?,?)`,
  ).bind(id, item.name, amount, receipt.currency, cycle, item.renews ?? addCycle(day, cycle), APPLE_PATTERN, sgd, deps.now().toISOString()).run();
  return id;
}

/** Subscription ids for the receipt's subscription-like items (created on first sight; the lookup is idempotent). */
async function receiptSubscriptions(env: Env, deps: Deps, receipt: ParsedAppleReceipt): Promise<string[]> {
  const ids: string[] = [];
  for (const item of receipt.items.filter(looksLikeSubscription)) {
    const id = await ensureAppleSubscription(env, deps, receipt, item);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Label the card charge ("Apple: <items>", any existing note kept after it), link the raw row and, for a one-subscription receipt, the subscription. */
async function labelCharge(env: Env, deps: Deps, rawId: string, receipt: ParsedAppleReceipt, txn: CandidateTxn, subIds: string[]): Promise<void> {
  const now = deps.now();
  const label = `Apple: ${receipt.items.map((i) => i.name).join(", ")}`;
  await env.DB.prepare("UPDATE transactions SET note = ?, updated_at = ? WHERE id = ?").bind(txn.note?.trim() ? `${label} | ${txn.note.trim()}` : label, now.toISOString(), txn.id).run();
  await env.DB.prepare("UPDATE raw_ingest SET transaction_id = ?, parse_status = 'ok', error = NULL WHERE id = ?").bind(txn.id, rawId).run();
  if (subIds.length === 1 && !txn.recurring_id) {
    const day = sgtDate(txn.occurred_at);
    await env.DB.prepare("UPDATE transactions SET recurring_id = ? WHERE id = ?").bind(subIds[0], txn.id).run();
    await env.DB.prepare("UPDATE subscriptions SET last_charged = ? WHERE id = ? AND (last_charged IS NULL OR last_charged < ?)").bind(day, subIds[0], day).run();
    await addSubscriptionEvent(env.DB, subIds[0]!, "charged", { txn_id: txn.id, amount_sgd: txn.amount_sgd_minor, via: "apple_receipt" }, now);
  }
}

/** A trusted Apple receipt mail (raw_ingest row already stored as 'received'). */
export async function handleAppleReceipt(env: Env, deps: Deps, rawId: string, text: string): Promise<ReceiptOutcome> {
  const receipt = parseAppleReceipt(text);
  if (!receipt) {
    await env.DB.prepare("UPDATE raw_ingest SET parse_status = 'failed', error = ? WHERE id = ?").bind("Apple receipt layout not recognised", rawId).run();
    return { action: "failed", error: "unparseable" };
  }
  const subscriptionIds = await receiptSubscriptions(env, deps, receipt);
  const txn = await findAppleCharge(env, receipt);
  // Apple often mails before the card charge posts: keep it 'ok' with no transaction; the daily cron tries again.
  await env.DB.prepare("UPDATE raw_ingest SET parse_status = 'ok', error = NULL WHERE id = ?").bind(rawId).run();
  if (txn) await labelCharge(env, deps, rawId, receipt, txn, subscriptionIds);
  return { action: "receipt", source: "apple", transactionId: txn?.id ?? null, subscriptionIds };
}

/** The payload of a stored mail minus our "Message-ID / Subject" header block. */
const bodyOf = (payload: string) => (/^(Message-ID|Subject):/.test(payload) ? payload.slice(payload.indexOf("\n\n") + 2) : payload);

/**
 * Daily cron: Apple receipts stored with no card charge yet (last 10 days) are re-parsed and matched again; a charge that has
 * arrived since gets labelled. Returns how many transactions were labelled.
 */
export async function rematchAppleReceipts(env: Env, deps: Deps): Promise<number> {
  const since = new Date(deps.now().getTime() - REMATCH_DAYS * DAY).toISOString();
  const rows = (await env.DB.prepare("SELECT id, payload FROM raw_ingest WHERE source = 'email:apple' AND transaction_id IS NULL AND parse_status = 'ok' AND received_at >= ? ORDER BY received_at").bind(since).all<{ id: string; payload: string | null }>()).results;
  let labelled = 0;
  for (const r of rows) {
    const receipt = parseAppleReceipt(bodyOf(r.payload ?? ""));
    if (!receipt) continue;
    const txn = await findAppleCharge(env, receipt);
    if (!txn) continue;
    await labelCharge(env, deps, r.id, receipt, txn, await receiptSubscriptions(env, deps, receipt));
    labelled++;
  }
  return labelled;
}

// ---------------------------------------------------------------- generic service receipts (LLM)

/** A trusted receipt mail with no regex parser: LLM extraction -> 'review' raw row + a candidate subscription. */
export async function handleGenericReceipt(env: Env, deps: Deps, rawId: string, header: string, text: string, receivedAt: string): Promise<ReceiptOutcome> {
  const r = await extractReceiptWithAi(deps.ai, text, receivedAt);
  if (!r) {
    await env.DB.prepare("UPDATE raw_ingest SET parse_status = 'failed', error = ? WHERE id = ?").bind("receipt: AI extraction unavailable or found nothing", rawId).run();
    return { action: "failed", error: "unparseable" };
  }
  const now = deps.now();
  const sgd = await sgdOf(env, deps, r.amount_minor, r.currency, r.date);
  const subs = (await loadAllSubscriptions(env.DB)).filter((s) => s.status !== "dismissed");
  const ex = findExistingSubscription(subs, { merchant: r.service, expected_sgd_minor: sgd });
  let subscriptionId: string | null = ex?.id ?? null;
  if (ex) {
    if (!ex.next_renewal && r.renews) await env.DB.prepare("UPDATE subscriptions SET next_renewal = ? WHERE id = ?").bind(r.renews, ex.id).run();
  } else if (!findExistingSubscription((await loadAllSubscriptions(env.DB)).filter((s) => s.status === "dismissed"), { merchant: r.service, expected_sgd_minor: sgd })) {
    const cycle: Cycle = r.cycle ?? "monthly";
    subscriptionId = ulid(now.getTime());
    await env.DB.prepare(
      `INSERT INTO subscriptions (id, name, amount_minor, currency, cycle, next_renewal, category_id, source, status, merchant_pattern, expected_sgd_minor, created_at)
       VALUES (?,?,?,?,?,?,'subscriptions','email_receipt','candidate',NULL,?,?)`,
    ).bind(subscriptionId, r.service, r.amount_minor, r.currency, cycle, r.renews ?? addCycle(r.date, cycle), sgd, now.toISOString()).run();
  }
  await env.DB.prepare("UPDATE raw_ingest SET payload = ?, parse_status = 'review', error = ? WHERE id = ?")
    .bind(`${header}Extracted: ${JSON.stringify(r)}\n\n${text}`, "Receipt read by AI: confirm or dismiss the candidate on the Subscriptions screen", rawId).run();
  return { action: "receipt", source: "receipt", subscriptionId };
}
