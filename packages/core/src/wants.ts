import { sgtDate, sgtLocalToUtc, sgtParts } from "./dates";
import { formatMoneyShort } from "./money";

/** Want list with a waiting timer (v2 feature W). Pure rules; SGT calendar days. */

export type WantStatus = "waiting" | "ready" | "bought" | "skipped";
export const WAIT_OPTIONS = [3, 7, 30] as const;
export const DEFAULT_WAIT_DAYS = 7;
export const LONG_WAIT_DAYS = 30;
/** Above this price (SGD minor) the default wait is 30 days; configurable (setting want_long_wait_threshold_minor). */
export const DEFAULT_LONG_WAIT_THRESHOLD = 20_000;

export function defaultWaitDays(priceSgdMinor: number, thresholdMinor = DEFAULT_LONG_WAIT_THRESHOLD): number {
  return priceSgdMinor > thresholdMinor ? LONG_WAIT_DAYS : DEFAULT_WAIT_DAYS;
}

const shiftDate = (date: string, days: number) => new Date(Date.parse(date) + days * 86400_000).toISOString().slice(0, 10);

/** decide_after = 00:00 SGT on (the SGT calendar date it was added + wait days) (D-62). */
export function decideAfter(addedAtUtc: string, waitDays: number): string {
  if (!Number.isInteger(waitDays) || waitDays < 0 || waitDays > 365) throw new Error(`bad wait: ${waitDays}`);
  return sgtLocalToUtc(shiftDate(sgtDate(addedAtUtc), waitDays), "00:00");
}

export type WantAction = "ready" | "buy" | "skip";
export type TransitionResult =
  | { ok: true; status: WantStatus; bought_early: boolean }
  | { ok: false; error: "not_due" | "final" | "confirm_early" };

/**
 * waiting → ready (only once decide_after has passed), waiting/ready → bought | skipped. Buying while still waiting is
 * allowed but needs one confirmation ("Bought before the wait ended?") and is recorded as bought_early. bought/skipped are final.
 */
export function transition(w: { status: WantStatus; decide_after: string }, action: WantAction, now: Date | string, opts: { confirmEarly?: boolean } = {}): TransitionResult {
  if (w.status === "bought" || w.status === "skipped") return { ok: false, error: "final" };
  const due = new Date(now).getTime() >= Date.parse(w.decide_after);
  if (action === "ready") return w.status === "waiting" && due ? { ok: true, status: "ready", bought_early: false } : { ok: false, error: "not_due" };
  if (action === "skip") return { ok: true, status: "skipped", bought_early: false };
  const early = w.status === "waiting" && !due;
  if (early && !opts.confirmEarly) return { ok: false, error: "confirm_early" };
  return { ok: true, status: "bought", bought_early: early };
}

/** Waiting items whose wait is over. */
export const dueForReady = <T extends { status: WantStatus; decide_after: string }>(wants: T[], now: Date | string): T[] =>
  wants.filter((w) => w.status === "waiting" && new Date(now).getTime() >= Date.parse(w.decide_after));

/** One push for all newly ready items: "Still want AirPods case (S$59)? Buy / Skip", batched when several. */
export function readyBatchBody(items: { name: string; price_sgd_minor: number }[]): string | null {
  if (items.length === 0) return null;
  const f = (i: { name: string; price_sgd_minor: number }) => `${i.name} (${formatMoneyShort(i.price_sgd_minor, "SGD")})`;
  if (items.length === 1) return `Still want ${f(items[0]!)}? Buy / Skip`;
  const shown = items.slice(0, 2).map(f);
  const more = items.length - shown.length;
  return `Still want these? ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}. Buy / Skip`;
}

/** "Not bought this year: S$412 (9 items)": skipped items decided in the SGT calendar year. */
export function skippedTotal(wants: { status: WantStatus; price_sgd_minor: number; decided_at: string | null }[], year: number): { total: number; count: number } {
  let total = 0, count = 0;
  for (const w of wants) {
    if (w.status !== "skipped" || !w.decided_at || sgtParts(w.decided_at).year !== year) continue;
    total += w.price_sgd_minor;
    count++;
  }
  return { total, count };
}

export const MATCH_AMOUNT_PCT = 10;
export const MATCH_WINDOW_DAYS = 14;

/** Transactions that could be the purchase of a bought want: SGD amount within ±10%, within 14 days of buying. Best first. */
export function suggestTransactionMatch<T extends { id: string; amount_sgd_minor: number; occurred_at: string; is_refund?: number | boolean }>(
  want: { price_sgd_minor: number; decided_at: string },
  txns: T[],
): T[] {
  const at = Date.parse(want.decided_at);
  const tol = (want.price_sgd_minor * MATCH_AMOUNT_PCT) / 100;
  return txns
    .filter((t) => !t.is_refund && Math.abs(t.amount_sgd_minor - want.price_sgd_minor) <= tol && Math.abs(Date.parse(t.occurred_at) - at) <= MATCH_WINDOW_DAYS * 86400_000)
    .sort((a, b) => Math.abs(a.amount_sgd_minor - want.price_sgd_minor) - Math.abs(b.amount_sgd_minor - want.price_sgd_minor) || Math.abs(Date.parse(a.occurred_at) - at) - Math.abs(Date.parse(b.occurred_at) - at));
}

/** Countdown for the list: whole days and hours left (0 when due). */
export function waitLeft(decideAfterUtc: string, now: Date | string): { days: number; hours: number; due: boolean } {
  const ms = Date.parse(decideAfterUtc) - new Date(now).getTime();
  if (ms <= 0) return { days: 0, hours: 0, due: true };
  const h = Math.ceil(ms / 3600_000);
  return { days: Math.floor(h / 24), hours: h % 24, due: false };
}
