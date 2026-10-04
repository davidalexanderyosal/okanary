import { sgtDate, sgtParts } from "@okanary/core";
import type { Deps } from "./deps";
import type { Env } from "./env";
import { sendWeeklyDigest } from "./digest";
import { getSgdRate } from "./fx";
import { runUnderspendPledges, underspendDue } from "./goals";
import { hasSnapshot, runNetworthJob, symbolsMissingFreshQuote } from "./networth-job";
import { sendMonthlySummary } from "./networth-summary";
import { flushOutbox, sendNudge } from "./nudge-gate";
import { runRecurringDetection } from "./recurring";
import { tripCovering } from "./trips";
import { nowIso, ulid } from "./util";
import { runWantsReady } from "./wants";

const STALE_PENDING_MS = 24 * 3600_000;
const EMAIL_SILENCE_DAYS = 3;

/** Spec §4.1: an Apple Pay record stays 'pending' until the matching email confirms it, or 24 h pass. */
export async function promoteStalePending(env: Env, deps: Deps): Promise<number> {
  const cutoff = new Date(deps.now().getTime() - STALE_PENDING_MS).toISOString();
  const r = await env.DB.prepare("UPDATE transactions SET status = 'confirmed', updated_at = ? WHERE status = 'pending' AND created_at < ?").bind(nowIso(), cutoff).run();
  return r.meta.changes ?? 0;
}

/** Spec §7: "Haven't heard from DBS emails in 3 days" (once per silence episode; helps catch broken forwarding). */
export async function emailHealthAlerts(env: Env, deps: Deps): Promise<string[]> {
  const sent: string[] = [];
  for (const bank of ["dbs", "citi"] as const) {
    const last = await env.DB.prepare("SELECT MAX(received_at) AS t FROM raw_ingest WHERE source = ?").bind(`email:${bank}`).first<{ t: string | null }>();
    if (!last?.t) continue; // never received: setup isn't finished, don't nag
    const days = (deps.now().getTime() - Date.parse(last.t)) / 86400_000;
    if (days < EMAIL_SILENCE_DAYS) continue;
    const period = last.t.slice(0, 10);
    const done = await env.DB.prepare("SELECT 1 AS x FROM alert_log WHERE kind = 'email_health' AND ref = ? AND period = ?").bind(bank, period).first();
    if (done) continue;
    await env.DB.prepare("INSERT INTO alert_log (id, kind, ref, period, sent_at) VALUES (?,?,?,?,?)").bind(ulid(), "email_health", bank, period, nowIso()).run();
    await sendNudge(env, deps, { title: "Okanary", body: `No ${bank.toUpperCase()} alert emails for ${Math.floor(days)} days. Check your Gmail forwarding filter.`, url: "/setup", tag: `health-${bank}` }, "email_health");
    sent.push(bank);
  }
  return sent;
}

/** Keeps today's SGD rate cached for every currency we've used lately (and the active trip's), so captures convert instantly. */
export async function refreshFx(env: Env, deps: Deps): Promise<string[]> {
  const since = new Date(deps.now().getTime() - 60 * 86400_000).toISOString();
  const cur = new Set((await env.DB.prepare("SELECT DISTINCT currency FROM transactions WHERE currency != 'SGD' AND occurred_at >= ?").bind(since).all<{ currency: string }>()).results.map((r) => r.currency));
  const trip = await tripCovering(env.DB, deps.now());
  if (trip?.currency && trip.currency !== "SGD") cur.add(trip.currency);
  const done: string[] = [];
  for (const c of cur) if (await getSgdRate(env.DB, c, deps.now(), deps.fetch)) done.push(c);
  return done;
}

/** Cron expressions (wrangler.jsonc "triggers.crons"). UTC; SGT = UTC+8. */
export const CRON_HOURLY = "0 * * * *";
export const CRON_DAILY = "0 18 * * *"; // 02:00 SGT: recurring detection
export const CRON_WEEKLY = "0 12 * * 0"; // Sunday 20:00 SGT: weekly digest
export const CRON_NETWORTH = "30 22 * * *"; // 06:30 SGT (after the US close): net worth prices + daily snapshot

/**
 * Net worth retries from the hourly trigger (plan-v2 §2.3): 07:00-11:00 SGT re-run (only the symbols still lacking a fresh
 * quote) while today's snapshot is missing or a held symbol has no fresh quote; at 12:00 SGT one last run with final: true keeps
 * the last known price, marked stale.
 */
export async function networthHourly(env: Env, deps: Deps): Promise<"retry" | "final" | null> {
  const now = deps.now();
  const hour = sgtParts(now).hour;
  if (hour < 7 || hour > 12) return null;
  const today = sgtDate(now);
  const incomplete = !(await hasSnapshot(env.DB, today)) || (await symbolsMissingFreshQuote(env.DB, today)).length > 0;
  if (!incomplete) return null;
  if (hour < 12) { await runNetworthJob(env, deps, { retry: true }); return "retry"; }
  await runNetworthJob(env, deps, { final: true, retry: true });
  return "final";
}

/** Cron entry: dispatches on the trigger's own expression. */
export async function runScheduled(env: Env, deps: Deps, cron: string): Promise<void> {
  if (cron === CRON_WEEKLY) {
    await sendWeeklyDigest(env, deps);
  } else if (cron === CRON_DAILY) {
    await runRecurringDetection(env, deps);
  } else if (cron === CRON_NETWORTH) {
    await runNetworthJob(env, deps);
  } else {
    await promoteStalePending(env, deps);
    await emailHealthAlerts(env, deps);
    await refreshFx(env, deps);
    await flushOutbox(env, deps);
    // Net worth steps are isolated: a failure here must not stop the jobs above or each other.
    await networthHourly(env, deps).catch((e) => console.error("networth retry failed", (e as Error).message));
    // Want list: waiting items whose wait is over become ready; ONE batched push through the nudge gate.
    await runWantsReady(env, deps).catch((e) => console.error("wants ready failed", (e as Error).message));
    // Monday 00:xx SGT (first day of the configured week): pledge last week's underspend to the receiving goal (once per week).
    if (await underspendDue(env, deps).catch(() => false)) await runUnderspendPledges(env, deps).catch((e) => console.error("underspend pledges failed", (e as Error).message));
    const sgt = sgtParts(deps.now());
    if (sgt.day === 1 && sgt.hour === 9) await sendMonthlySummary(env, deps).catch((e) => console.error("monthly summary failed", (e as Error).message)); // 1st, 09:00 SGT
  }
}
