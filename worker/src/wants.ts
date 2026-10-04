import { DEFAULT_LONG_WAIT_THRESHOLD, dueForReady, readyBatchBody, waitLeft, type WantStatus } from "@okanary/core";
import type { Deps } from "./deps";
import type { Env } from "./env";
import { sendNudge } from "./nudge-gate";
import { getSetting } from "./settings";

/** Want list (v2 W), worker side: row type, shared loaders and the hourly "ready" step. Rules live in packages/core/src/wants.ts. */

export interface WantRow {
  id: string; name: string; price_minor: number; currency: string; price_sgd_minor: number;
  url: string | null; note: string | null; category_id: string | null;
  wait_days: number; added_at: string; decide_after: string;
  status: WantStatus; decided_at: string | null; transaction_id: string | null; bought_early: number;
}

/** The row plus the countdown (`left`) the UI shows. */
export const withLeft = (w: WantRow, now: Date) => ({ ...w, left: waitLeft(w.decide_after, now) });

/** Setting want_long_wait_threshold_minor (SGD minor): above this price the default wait is 30 days. */
export async function loadLongWaitThreshold(db: D1Database): Promise<number> {
  const raw = await getSetting(db, "want_long_wait_threshold_minor");
  const n = raw == null ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_LONG_WAIT_THRESHOLD;
}

export const getWant = (db: D1Database, id: string) => db.prepare("SELECT * FROM wants WHERE id = ?").bind(id).first<WantRow>();

/**
 * Hourly cron step: waiting wants whose decide_after has passed become 'ready', and ONE batched push goes out through the
 * nudge gate ("Still want X (S$59)? Buy / Skip"; several items are batched). Idempotent: a second run finds nothing waiting.
 */
export async function runWantsReady(env: Env, deps: Deps): Promise<{ ready: string[] }> {
  const now = deps.now();
  const waiting = (await env.DB.prepare("SELECT * FROM wants WHERE status = 'waiting' AND decide_after <= ? ORDER BY decide_after, added_at, id").bind(now.toISOString()).all<WantRow>()).results;
  const became: WantRow[] = [];
  for (const w of dueForReady(waiting, now)) {
    const r = await env.DB.prepare("UPDATE wants SET status = 'ready' WHERE id = ? AND status = 'waiting'").bind(w.id).run();
    if (r.meta.changes) became.push(w);
  }
  const body = readyBatchBody(became);
  if (body) await sendNudge(env, deps, { title: "Okanary: want list", body, url: "/wants?tab=ready", tag: "want-ready" }, "want_ready");
  return { ready: became.map((w) => w.id) };
}
