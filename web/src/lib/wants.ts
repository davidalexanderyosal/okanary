import { DEFAULT_WAIT_DAYS, WAIT_OPTIONS, defaultWaitDays, formatMoneyShort } from "@okanary/core";

/** Whole dollars from S$10 up, cents below: the same wording as the ready push ("S$59"). */
const sgd = (minor: number) => formatMoneyShort(minor, "SGD");

/** Want list (v2 W): small pure helpers for the screen, Home, Reports and the Quick add hand-off. Rules live in core/wants.ts. */

export type WantTab = "waiting" | "ready" | "decided";
export const WANT_TABS: [WantTab, string][] = [["waiting", "Waiting"], ["ready", "Ready"], ["decided", "Decided"]];
export const parseWantTab = (v: string | null | undefined): WantTab => (v === "ready" || v === "decided" ? v : "waiting");

export const WAIT_CHOICES: readonly number[] = WAIT_OPTIONS;
export const waitChipLabel = (days: number) => `${days} days`;

/** Countdown on a list item: "6 days left", "12 hours left", "Ready". */
export function countdownText(left: { days: number; hours: number; due: boolean }): string {
  if (left.due) return "Ready";
  if (left.days >= 1) return `${left.days} ${left.days === 1 ? "day" : "days"} left`;
  return `${left.hours} ${left.hours === 1 ? "hour" : "hours"} left`;
}

/** Default wait for a typed price (SGD minor): 7 days, 30 above the threshold; 7 while nothing is typed yet. */
export function defaultWaitForPrice(priceSgdMinor: number | null | undefined, thresholdMinor?: number): number {
  if (!priceSgdMinor || priceSgdMinor <= 0) return DEFAULT_WAIT_DAYS;
  return defaultWaitDays(priceSgdMinor, thresholdMinor);
}

/** "Not bought this year: S$412 (9 items)"; nothing when there are none. */
export function notBoughtText(stats: { skipped_total_minor: number; skipped_count: number } | null | undefined): string | null {
  if (!stats || stats.skipped_count <= 0) return null;
  return `Not bought this year: ${sgd(stats.skipped_total_minor)} (${stats.skipped_count} ${stats.skipped_count === 1 ? "item" : "items"})`;
}

/** After a skip: "Add S$59 to 🇯🇵 Japan trip?" */
export function skipOfferText(offer: { amount: number; name: string; emoji: string | null }): string {
  return `Add ${sgd(offer.amount)} to ${offer.emoji ? `${offer.emoji} ` : ""}${offer.name}?`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** '2026-10-14T…Z' (SGT) -> '14 Oct' */
export function decidedDateText(utcIso: string, sgtDate: (iso: string) => string): string {
  const [, m, d] = sgtDate(utcIso).split("-");
  return `${+d!} ${MONTHS[+m! - 1]}`;
}

/** Decided tab line: "Skipped 14 Oct" / "Bought 14 Oct"; an early buy gets a small neutral note, no judgement. */
export function decidedLine(w: { status: string; decided_at: string | null; bought_early: number }, sgtDate: (iso: string) => string): string {
  const verb = w.status === "skipped" ? "Skipped" : "Bought";
  const when = w.decided_at ? ` ${decidedDateText(w.decided_at, sgtDate)}` : "";
  return `${verb}${when}${w.status === "bought" && w.bought_early ? " · bought early" : ""}`;
}

// ---- hand-off from Quick add: /wants?add=1&price=<minor>&cur=JPY&name=Starbucks ----
export interface WantPrefill { priceMinor: number | null; currency: string | null; name: string }

export function wantsAddLink(p: { amountMinor?: number; currency?: string; name?: string }): string {
  const q = new URLSearchParams({ add: "1" });
  if (p.amountMinor && p.amountMinor > 0) q.set("price", String(Math.round(p.amountMinor)));
  if (p.currency) q.set("cur", p.currency);
  if (p.name?.trim()) q.set("name", p.name.trim());
  return `/wants?${q.toString()}`;
}

export function parsePrefill(q: URLSearchParams): WantPrefill | null {
  if (q.get("add") !== "1") return null;
  const price = Number(q.get("price"));
  const cur = q.get("cur");
  return {
    priceMinor: Number.isInteger(price) && price > 0 ? price : null,
    currency: cur && /^[A-Za-z]{3}$/.test(cur) ? cur.toUpperCase() : null,
    name: (q.get("name") ?? "").slice(0, 120),
  };
}
