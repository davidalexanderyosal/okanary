import {
  addCycle, chargeMatches, detectMonthly, findExistingSubscription, formatMoney, isCharging, isSpend, merchantSimilarity, normalizeMerchant, prettyMerchant, priceChange, priceChangeMessage,
  missingCharge, quarterOf, renewalReminderDue, sgtDate, subscriptionFixedCosts, trialReminderBody, trialReminderDue,
  type Cycle, type RecurringCandidate, type SubStatus, type SummaryRow, type Transaction,
} from "@okanary/core";
import type { Deps } from "./deps";
import { TXN_WITH_GROUP_SQL } from "./db";
import type { Env } from "./env";
import { sendNudge } from "./nudge-gate";
import { ulid } from "./util";

/**
 * Subscriptions hub (v2 S), worker side: ONE `subscriptions` table (migration 0008, D-63). Rules live in
 * packages/core/src/subscriptions.ts and recurring.ts; this file loads rows, calls them and does the I/O.
 * `transactions.recurring_id` means "subscription id". All timestamps come from deps.now(); all dates are SGT.
 */

export interface SubRow {
  id: string; name: string; catalogue_key: string | null; amount_minor: number | null; currency: string; cycle: Cycle;
  next_renewal: string | null; account_id: string | null; category_id: string | null; source: "detected" | "manual" | "apple_receipt" | "email_receipt";
  status: SubStatus; trial_ends: string | null; merchant_pattern: string | null; last_charged: string | null; created_at: string | null;
  pending_price_sgd_minor: number | null; expected_sgd_minor: number;
  /** from categories (Essentials vs Lifestyle in totals) */
  group_id: string | null;
}

const SUB_SQL = "SELECT s.*, c.group_id AS group_id FROM subscriptions s LEFT JOIN categories c ON c.id = s.category_id";

/** All subscription rows (any status), with the category's group; NULL legacy values are normalised. */
export async function loadAllSubscriptions(db: D1Database): Promise<SubRow[]> {
  const rows = (await db.prepare(`${SUB_SQL} ORDER BY s.expected_sgd_minor DESC, s.name, s.id`).all<SubRow>()).results;
  return rows.map((r) => ({ ...r, cycle: r.cycle ?? "monthly", name: r.name ?? "", expected_sgd_minor: r.expected_sgd_minor ?? r.amount_minor ?? 0 }));
}

export async function getSubscription(db: D1Database, id: string): Promise<SubRow | null> {
  const r = await db.prepare(`${SUB_SQL} WHERE s.id = ?`).bind(id).first<SubRow>();
  return r ? { ...r, cycle: r.cycle ?? "monthly", name: r.name ?? "", expected_sgd_minor: r.expected_sgd_minor ?? r.amount_minor ?? 0 } : null;
}

export async function addSubscriptionEvent(db: D1Database, subId: string, kind: string, data: unknown, at: Date): Promise<void> {
  await db.prepare("INSERT INTO subscription_events (id, subscription_id, kind, data_json, at) VALUES (?,?,?,?,?)").bind(ulid(at.getTime()), subId, kind, data === undefined ? null : JSON.stringify(data), at.toISOString()).run();
}

/** For the plan engine (feature P): fixed costs from S over the charging subscriptions (active + cancel_intended), plus that list. */
export async function loadSubscriptionFixedCosts(db: D1Database): Promise<{ fixed: { monthly: number; setAside: number; total: number }; items: SubRow[] }> {
  const items = (await loadAllSubscriptions(db)).filter((s) => isCharging(s.status));
  return { fixed: subscriptionFixedCosts(items), items };
}

// ---------------------------------------------------------------- linking transactions

/** Link unlinked, non-void, non-refund transactions whose merchant matches `pattern` (chargeMatches: exact or prefix) to the subscription. */
export async function linkTransactions(db: D1Database, subId: string, pattern: string | null): Promise<number> {
  const p = pattern ? normalizeMerchant(pattern) : "";
  if (!p) return 0;
  const like = p.replace(/[\\%_]/g, "\\$&") + "%";
  const rows = (await db.prepare("SELECT id, merchant FROM transactions WHERE recurring_id IS NULL AND status != 'void' AND is_refund = 0 AND merchant LIKE ? ESCAPE '\\'").bind(like).all<{ id: string; merchant: string | null }>()).results;
  const ids = rows.filter((r) => chargeMatches(r.merchant, pattern)).map((r) => r.id);
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    await db.prepare(`UPDATE transactions SET recurring_id = ? WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(subId, ...chunk).run();
  }
  return ids.length;
}

// ---------------------------------------------------------------- detection (daily cron + "Scan now")

const MORE = (n: number) => (n > 0 ? ` and ${n} more` : "");

export function candidatePushBody(items: { name: string; amount: number }[]): string {
  const shown = items.slice(0, 4).map((i) => `${i.name} ${formatMoney(i.amount)}/month`);
  return `New subscription${items.length > 1 ? "s" : ""}? ${shown.join(", ")}${MORE(items.length - shown.length)}`;
}

/**
 * Detection (D-40 as changed by D-64): 2 consecutive monthly charges of the same merchant make a 'candidate'. Existing
 * subscriptions (manual or detected) are MERGED, never duplicated; dismissed ones are never resurrected; a cancelled one only
 * comes back as a new candidate when charges continue after the cancellation. One push for all NEW candidates (nudge gate).
 */
export async function runSubscriptionDetection(env: Env, deps: Deps): Promise<{ added: number; updated: number }> {
  const now = deps.now();
  const since = new Date(now.getTime() - 400 * 86400_000).toISOString();
  const rows = (await env.DB.prepare(`${TXN_WITH_GROUP_SQL} WHERE t.occurred_at >= ? AND t.merchant IS NOT NULL`).bind(since).all<SummaryRow>()).results;
  // trips only hide spend from monthly views; a subscription charged while travelling is still a subscription
  const spend = rows.filter((r) => !r.is_refund && isSpend(r, { ignoreTripExclusion: true })).map((r) => ({ merchant: r.merchant ?? null, occurred_at: r.occurred_at, amount_sgd_minor: r.amount_sgd_minor, category_id: r.category_id }));
  const found: RecurringCandidate[] = detectMonthly(spend, now);
  if (found.length === 0) return { added: 0, updated: 0 };

  const subs = await loadAllSubscriptions(env.DB);
  const created: { name: string; amount: number }[] = [];
  let updated = 0;
  for (const c of found) {
    const ex = findExistingSubscription(subs.filter((s) => s.status !== "dismissed"), { merchant: c.merchant, expected_sgd_minor: c.expected_amount_sgd_minor });
    if (ex) {
      if (ex.source === "detected" && ex.status === "candidate") {
        await env.DB.prepare("UPDATE subscriptions SET expected_sgd_minor = ?, amount_minor = CASE WHEN currency = 'SGD' THEN ? ELSE amount_minor END, next_renewal = ?, cycle = 'monthly', merchant_pattern = COALESCE(merchant_pattern, ?), category_id = COALESCE(category_id, ?) WHERE id = ?")
          .bind(c.expected_amount_sgd_minor, c.expected_amount_sgd_minor, c.next_expected, c.merchant, c.category_id, ex.id).run();
      } else if (ex.source === "detected") {
        // confirmed ones keep their price (a changed price goes through the price-change flag); only the next renewal can move forward
        if (!ex.next_renewal || c.next_expected > ex.next_renewal) await env.DB.prepare("UPDATE subscriptions SET next_renewal = ? WHERE id = ?").bind(c.next_expected, ex.id).run();
        if (!ex.merchant_pattern) await env.DB.prepare("UPDATE subscriptions SET merchant_pattern = ? WHERE id = ?").bind(c.merchant, ex.id).run();
      } else if (!ex.merchant_pattern) {
        await env.DB.prepare("UPDATE subscriptions SET merchant_pattern = ? WHERE id = ?").bind(c.merchant, ex.id).run();
      }
      const pattern = ex.merchant_pattern ?? c.merchant;
      await linkTransactions(env.DB, ex.id, pattern);
      if (!chargeMatches(c.merchant, pattern)) await linkTransactions(env.DB, ex.id, c.merchant);
      updated++;
      continue;
    }
    // dismissed: "Not one" is never resurrected
    if (findExistingSubscription(subs.filter((s) => s.status === "dismissed"), { merchant: c.merchant, expected_sgd_minor: c.expected_amount_sgd_minor })) continue;
    // cancelled: only a new candidate when charges continue after the cancellation
    const cancelled = subs.filter((s) => s.status === "cancelled" && ((s.merchant_pattern && chargeMatches(c.merchant, s.merchant_pattern)) || merchantSimilarity(s.name, c.merchant) >= 0.5));
    if (cancelled.length) {
      let resubscribed = true;
      for (const s of cancelled) {
        const ev = await env.DB.prepare("SELECT MAX(at) AS at FROM subscription_events WHERE subscription_id = ? AND kind = 'cancelled' AND data_json NOT LIKE '%\"intent\":true%'").bind(s.id).first<{ at: string | null }>();
        if (!ev?.at || c.last_date <= sgtDate(ev.at)) resubscribed = false;
      }
      if (!resubscribed) continue;
    }

    const id = ulid(now.getTime());
    const name = prettyMerchant(c.merchant);
    await env.DB.prepare(
      `INSERT INTO subscriptions (id, name, amount_minor, currency, cycle, next_renewal, category_id, source, status, merchant_pattern, expected_sgd_minor, created_at)
       VALUES (?,?,?,'SGD','monthly',?,?,'detected','candidate',?,?,?)`,
    ).bind(id, name, c.expected_amount_sgd_minor, c.next_expected, c.category_id, c.merchant, c.expected_amount_sgd_minor, now.toISOString()).run();
    await linkTransactions(env.DB, id, c.merchant);
    subs.push({ id, name, catalogue_key: null, amount_minor: c.expected_amount_sgd_minor, currency: "SGD", cycle: "monthly", next_renewal: c.next_expected, account_id: null, category_id: c.category_id, source: "detected", status: "candidate", trial_ends: null, merchant_pattern: c.merchant, last_charged: null, created_at: now.toISOString(), pending_price_sgd_minor: null, expected_sgd_minor: c.expected_amount_sgd_minor, group_id: null });
    created.push({ name, amount: c.expected_amount_sgd_minor });
  }
  if (created.length) await sendNudge(env, deps, { title: "Okanary", body: candidatePushBody(created), url: "/subscriptions", tag: "sub-candidate" }, "subscription_candidate");
  return { added: created.length, updated };
}

// ---------------------------------------------------------------- charge hook (every captured / manual transaction)

/**
 * After a transaction is created: link it to the active / trial / cancel-intended subscription whose merchant pattern matches,
 * move last_charged and next_renewal, activate a trial that has now been charged, log the charge and flag a price change
 * (pending price + one push). Never throws: a failure here must not lose the transaction.
 */
export async function onChargeRecorded(env: Env, deps: Deps, txn: Pick<Transaction, "id" | "merchant" | "occurred_at" | "amount_minor" | "currency" | "amount_sgd_minor" | "is_refund" | "status">): Promise<void> {
  try {
    if (!txn.merchant || txn.is_refund || txn.status === "void") return;
    const live = (await env.DB.prepare("SELECT * FROM subscriptions WHERE status IN ('active','cancel_intended','trial') AND merchant_pattern IS NOT NULL").all<SubRow>()).results;
    const matches = live.filter((s) => chargeMatches(txn.merchant, s.merchant_pattern));
    if (matches.length === 0) return;
    // several subscriptions can share a pattern (e.g. APPLE.COM/BILL): the one whose expected amount is closest
    const sub = matches.sort((a, b) => Math.abs((a.expected_sgd_minor ?? 0) - txn.amount_sgd_minor) - Math.abs((b.expected_sgd_minor ?? 0) - txn.amount_sgd_minor))[0]!;
    const now = deps.now();
    const day = sgtDate(txn.occurred_at);
    await env.DB.prepare("UPDATE transactions SET recurring_id = ? WHERE id = ?").bind(sub.id, txn.id).run();
    if (sub.last_charged && day < sub.last_charged) return; // a back-dated entry: linked, but it doesn't move the schedule

    const becomesActive = sub.status === "trial" && (!sub.trial_ends || day >= sub.trial_ends);
    await env.DB.prepare("UPDATE subscriptions SET last_charged = ?, next_renewal = ?, status = ? WHERE id = ?")
      .bind(day, addCycle(day, sub.cycle ?? "monthly"), becomesActive ? "active" : sub.status, sub.id).run();
    await addSubscriptionEvent(env.DB, sub.id, "charged", { txn_id: txn.id, amount_sgd: txn.amount_sgd_minor }, now);

    // Several subscriptions behind one card descriptor (APPLE.COM/BILL) can be billed together, so a charge there says nothing
    // reliable about one subscription's price: no price-change flag (the Apple receipt labels such charges instead).
    if (matches.length > 1) return;
    const expected = sub.expected_sgd_minor ?? 0;
    if (txn.amount_sgd_minor <= 0 || expected <= 0) return; // SGD amount unknown (FX unavailable) or no expectation: nothing to compare
    const pc = priceChange(expected, txn.amount_sgd_minor, txn.currency !== "SGD");
    if (!pc.changed || sub.pending_price_sgd_minor === txn.amount_sgd_minor) return;
    await env.DB.prepare("UPDATE subscriptions SET pending_price_sgd_minor = ? WHERE id = ?").bind(txn.amount_sgd_minor, sub.id).run();
    await addSubscriptionEvent(env.DB, sub.id, "price_change", { from: expected, to: txn.amount_sgd_minor, txn_id: txn.id }, now);
    await sendNudge(env, deps, { title: "Okanary", body: priceChangeMessage(sub.name, expected, txn.amount_sgd_minor, sub.cycle ?? "monthly"), url: "/subscriptions", tag: `sub-price-${sub.id}` }, "subscription_price");
  } catch (e) {
    console.error("subscription charge hook failed", e instanceof Error ? e.message : String(e));
  }
}

// ---------------------------------------------------------------- daily reminders (cron 02:00 SGT; pushes land at 08:00 via the gate)

/** INSERT OR IGNORE into alert_log; true when this (kind, ref, period) was not there yet. */
async function once(env: Env, deps: Deps, kind: string, ref: string, period: string): Promise<boolean> {
  const r = await env.DB.prepare("INSERT OR IGNORE INTO alert_log (id, kind, ref, period, sent_at) VALUES (?,?,?,?,?)").bind(ulid(), kind, ref, period, deps.now().toISOString()).run();
  return !!r.meta.changes;
}

/** Free trials: from 2 days before trial_ends (SGT), once per subscription per trial_ends. */
export async function runTrialReminders(env: Env, deps: Deps): Promise<string[]> {
  const now = deps.now();
  const sent: string[] = [];
  for (const s of (await loadAllSubscriptions(env.DB)).filter((x) => x.status === "trial" && x.trial_ends && trialReminderDue(x.trial_ends, now))) {
    if (!(await once(env, deps, "sub_trial", s.id, s.trial_ends!))) continue;
    await addSubscriptionEvent(env.DB, s.id, "trial_reminder", { trial_ends: s.trial_ends }, now);
    await sendNudge(env, deps, { title: "Okanary", body: trialReminderBody(s.name, s.trial_ends!, s.expected_sgd_minor, s.cycle), url: "/subscriptions", tag: `sub-trial-${s.id}` }, "subscription_trial");
    sent.push(s.id);
  }
  return sent;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayMonth = (d: string) => `${+d.slice(8, 10)} ${MONTHS[+d.slice(5, 7) - 1]}`;

/** Annual renewals: 7 days before, once per renewal date. */
export async function runRenewalReminders(env: Env, deps: Deps): Promise<string[]> {
  const now = deps.now();
  const today = sgtDate(now);
  const sent: string[] = [];
  for (const s of (await loadAllSubscriptions(env.DB)).filter((x) => renewalReminderDue(x, today))) {
    if (!(await once(env, deps, "sub_renewal", s.id, s.next_renewal!))) continue;
    await addSubscriptionEvent(env.DB, s.id, "renewal_reminder", { next_renewal: s.next_renewal }, now);
    await sendNudge(env, deps, { title: "Okanary", body: `${s.name} renews on ${dayMonth(s.next_renewal!)}: ${formatMoney(s.expected_sgd_minor)}`, url: "/subscriptions", tag: `sub-renewal-${s.id}` }, "subscription_renewal");
    sent.push(s.id);
  }
  return sent;
}

/** Missing charge: no push, only the flag in GET /api/subscriptions; one 'missing' event per expected date for the history. */
export async function runMissingCharges(env: Env, deps: Deps): Promise<string[]> {
  const now = deps.now();
  const today = sgtDate(now);
  const flagged: string[] = [];
  for (const s of (await loadAllSubscriptions(env.DB)).filter((x) => missingCharge(x, today))) {
    if (!(await once(env, deps, "sub_missing", s.id, s.next_renewal!))) continue;
    await addSubscriptionEvent(env.DB, s.id, "missing", { expected: s.next_renewal }, now);
    flagged.push(s.id);
  }
  return flagged;
}

/** Quarterly "Still using?": the first daily run of a quarter that has active subscriptions sends ONE batched push. */
export async function runUsageCheck(env: Env, deps: Deps): Promise<boolean> {
  const active = (await loadAllSubscriptions(env.DB)).filter((s) => s.status === "active");
  if (active.length === 0) return false;
  if (!(await once(env, deps, "sub_usage", "all", quarterOf(sgtDate(deps.now()))))) return false;
  const shown = active.slice(0, 6).map((s) => s.name);
  await sendNudge(env, deps, { title: "Okanary", body: `Still using these? ${shown.join(", ")}${MORE(active.length - shown.length)} — Keep / Cancel`, url: "/subscriptions?check=1", tag: "sub-usage" }, "subscription_usage");
  return true;
}
