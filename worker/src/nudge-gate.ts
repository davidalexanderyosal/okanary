import { OUTBOX_MAX_AGE_MS, dayRangeUtc, nudgeDecision, parseNudgeLimit, parseQuietHours, sgtDate } from "@okanary/core";
import type { Deps } from "./deps";
import type { Env } from "./env";
import { sendPushToAll, type PushPayload } from "./push";
import { getSetting } from "./settings";
import { ulid } from "./util";

/**
 * Nudge gate (brief "Notification limit", plan-v2 §2.2): every push except the post-purchase one goes through here.
 * At most N sent per SGT day (setting nudge_daily_limit, default 2) and none during quiet hours (default 23:00–08:00 SGT).
 * Pushes that may not go out now are stored in push_outbox with send_after and flushed by the hourly cron.
 * All timestamps come from deps.now().
 */

async function gateSettings(env: Env) {
  const [limit, qs, qe] = await Promise.all([getSetting(env.DB, "nudge_daily_limit"), getSetting(env.DB, "quiet_start"), getSetting(env.DB, "quiet_end")]);
  return { limit: parseNudgeLimit(limit), quiet: parseQuietHours(qs, qe) };
}

async function sentTodayCount(env: Env, now: Date): Promise<number> {
  const day = dayRangeUtc(sgtDate(now));
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM push_outbox WHERE sent_at >= ? AND sent_at < ?").bind(day.start, day.end).first<{ n: number }>();
  return r?.n ?? 0;
}

export async function sendNudge(env: Env, deps: Deps, payload: PushPayload, kind: string): Promise<"sent" | "held"> {
  const now = deps.now();
  const { limit, quiet } = await gateSettings(env);
  const decision = nudgeDecision(now, await sentTodayCount(env, now), limit, quiet);
  const iso = now.toISOString();
  const insert = (sendAfter: string, sentAt: string | null) =>
    env.DB.prepare("INSERT INTO push_outbox (id, kind, tag, payload_json, created_at, send_after, sent_at) VALUES (?,?,?,?,?,?,?)")
      .bind(ulid(now.getTime()), kind, payload.tag ?? null, JSON.stringify(payload), iso, sendAfter, sentAt).run();
  if (decision.action === "send") {
    await sendPushToAll(env, deps, payload);
    await insert(iso, iso);
    return "sent";
  }
  await insert(decision.until, null);
  return "held";
}

interface OutboxRow { id: string; tag: string | null; payload_json: string; created_at: string }

/** Deliver held pushes that are due (still respecting the daily limit and quiet hours). */
export async function flushOutbox(env: Env, deps: Deps): Promise<{ sent: number; dropped: number }> {
  const now = deps.now();
  const iso = now.toISOString();
  let dropped = 0;

  // (a) expired
  const cutoff = new Date(now.getTime() - OUTBOX_MAX_AGE_MS).toISOString();
  dropped += (await env.DB.prepare("UPDATE push_outbox SET dropped = 1 WHERE sent_at IS NULL AND dropped = 0 AND created_at < ?").bind(cutoff).run()).meta.changes ?? 0;

  // (b) coalesce due rows sharing a tag: newest wins
  let due = (await env.DB.prepare("SELECT id, tag, payload_json, created_at FROM push_outbox WHERE sent_at IS NULL AND dropped = 0 AND send_after <= ? ORDER BY created_at, id").bind(iso).all<OutboxRow>()).results;
  const newest = new Map<string, OutboxRow>();
  for (const r of due) if (r.tag) newest.set(r.tag, r); // ordered oldest -> newest, so the last one wins
  const superseded = due.filter((r) => r.tag && newest.get(r.tag) !== r);
  for (const r of superseded) await env.DB.prepare("UPDATE push_outbox SET dropped = 1 WHERE id = ?").bind(r.id).run();
  dropped += superseded.length;
  due = due.filter((r) => !r.tag || newest.get(r.tag) === r);

  // (c) send oldest first
  const { limit, quiet } = await gateSettings(env);
  let sentToday = await sentTodayCount(env, now);
  let sent = 0;
  for (let i = 0; i < due.length; i++) {
    const decision = nudgeDecision(now, sentToday, limit, quiet);
    if (decision.action === "hold") {
      for (const r of due.slice(i)) await env.DB.prepare("UPDATE push_outbox SET send_after = ? WHERE id = ?").bind(decision.until, r.id).run();
      break;
    }
    const row = due[i]!;
    await sendPushToAll(env, deps, JSON.parse(row.payload_json) as PushPayload);
    await env.DB.prepare("UPDATE push_outbox SET sent_at = ? WHERE id = ?").bind(iso, row.id).run();
    sentToday++;
    sent++;
  }
  return { sent, dropped };
}
