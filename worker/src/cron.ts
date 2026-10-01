import type { Deps } from "./deps";
import type { Env } from "./env";
import { getSgdRate } from "./fx";
import { sendPushToAll } from "./push";
import { tripCovering } from "./trips";
import { nowIso, ulid } from "./util";

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
    await sendPushToAll(env, deps, { title: "Okanary", body: `No ${bank.toUpperCase()} alert emails for ${Math.floor(days)} days. Check your Gmail forwarding filter.`, url: "/setup", tag: `health-${bank}` });
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

/** Cron entry. Later phases dispatch on `cron` for the daily/weekly jobs. */
export async function runScheduled(env: Env, deps: Deps, _cron: string): Promise<void> {
  await promoteStalePending(env, deps);
  await emailHealthAlerts(env, deps);
  await refreshFx(env, deps);
}
