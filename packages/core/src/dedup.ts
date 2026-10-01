import { merchantSimilarity } from "./merchant";

/** Spec §4.3: the same purchase can arrive from both Apple Pay and a bank email. */
export interface DedupTxn {
  id: string;
  source: "manual" | "applepay" | "email" | "import";
  account_id: string | null;
  currency: string;
  amount_minor: number;
  occurred_at: string;
  merchant: string | null;
}

export type MatchStrength = "match" | "maybe" | "none";

export const DEDUP_WINDOW_MS = 30 * 60_000;
export const DEDUP_AMOUNT_TOLERANCE = 0.01; // 1%
export const SIMILARITY_MATCH = 0.5;
export const SIMILARITY_MAYBE = 0.25;

/** |a-b| <= 1% of the larger amount (at least 1 minor unit), integer math only. */
export function amountsClose(a: number, b: number): boolean {
  const diff = Math.abs(a - b);
  const big = Math.max(a, b);
  return diff <= Math.max(1, Math.floor(big / 100));
}

/**
 * match = same card (both known and equal), same currency, amount within 1%, within 30 min, merchant similar -> auto-merge.
 * maybe = passes the hard checks but the card is unknown on one side or the merchant is only loosely similar -> "Possible duplicate" card.
 * Only ever matches ACROSS sources (apple pay <-> email): two identical coffees from one source are two purchases.
 */
export function matchStrength(a: DedupTxn, b: DedupTxn): MatchStrength {
  if (a.source === b.source) return "none";
  const pair = new Set([a.source, b.source]);
  if (!(pair.has("applepay") && pair.has("email"))) return "none";
  if (a.currency !== b.currency) return "none";
  if (!amountsClose(a.amount_minor, b.amount_minor)) return "none";
  if (Math.abs(Date.parse(a.occurred_at) - Date.parse(b.occurred_at)) > DEDUP_WINDOW_MS) return "none";
  if (a.account_id && b.account_id && a.account_id !== b.account_id) return "none";
  const sim = merchantSimilarity(a.merchant ?? "", b.merchant ?? "");
  const sameCard = !!a.account_id && a.account_id === b.account_id;
  if (sameCard && sim >= SIMILARITY_MATCH) return "match";
  if (sim >= SIMILARITY_MAYBE) return "maybe";
  return "none";
}

/** Best candidate: strongest class first, then closest in time. */
export function bestCandidate<T extends DedupTxn>(incoming: DedupTxn, candidates: T[]): { candidate: T; strength: "match" | "maybe" } | null {
  let best: { candidate: T; strength: "match" | "maybe"; dt: number } | null = null;
  for (const c of candidates) {
    const s = matchStrength(incoming, c);
    if (s === "none") continue;
    const dt = Math.abs(Date.parse(incoming.occurred_at) - Date.parse(c.occurred_at));
    if (!best || (s === "match" && best.strength === "maybe") || (s === best.strength && dt < best.dt)) best = { candidate: c, strength: s, dt };
  }
  return best ? { candidate: best.candidate, strength: best.strength } : null;
}
