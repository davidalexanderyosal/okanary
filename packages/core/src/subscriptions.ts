import { sgtDate } from "./dates";
import { addDays } from "./cycle";
import { monthsToReach, projectedValue } from "./goals";
import { merchantSimilarity, normalizeMerchant } from "./merchant";
import { formatMoney, formatMoneyShort } from "./money";

/** Subscriptions hub (v2 feature S). Pure rules; SGD minor units; SGT calendar dates 'YYYY-MM-DD'. */

export type Cycle = "weekly" | "monthly" | "quarterly" | "yearly";
export type SubStatus = "candidate" | "active" | "trial" | "cancel_intended" | "cancelled" | "dismissed";
export const CYCLES: Cycle[] = ["weekly", "monthly", "quarterly", "yearly"];

const PER_YEAR: Record<Cycle, number> = { weekly: 52, monthly: 12, quarterly: 4, yearly: 1 };

/** Monthly equivalent: yearly ÷ 12, quarterly ÷ 3, weekly × 52 ÷ 12 (rounded half up to the cent). */
export function monthlyEquivalent(amountMinor: number, cycle: Cycle): number {
  return Math.round((amountMinor * PER_YEAR[cycle]) / 12);
}
export const yearlyEquivalent = (amountMinor: number, cycle: Cycle): number => amountMinor * PER_YEAR[cycle];

/** Statuses that are (still) being charged and count in totals and the plan's fixed costs. */
export const isCharging = (s: SubStatus) => s === "active" || s === "cancel_intended";

export interface SubForTotals { expected_sgd_minor: number; cycle: Cycle; status: SubStatus; group_id: string | null }

/** Totals per month and per year, split Essentials vs Lifestyle (anything not Essentials counts as Lifestyle). */
export function subscriptionTotals(subs: SubForTotals[]): { monthly: number; yearly: number; essentials: number; lifestyle: number; count: number } {
  const t = { monthly: 0, yearly: 0, essentials: 0, lifestyle: 0, count: 0 };
  for (const s of subs) {
    if (!isCharging(s.status)) continue;
    const m = monthlyEquivalent(s.expected_sgd_minor, s.cycle);
    t.monthly += m;
    t.yearly += yearlyEquivalent(s.expected_sgd_minor, s.cycle);
    if (s.group_id === "essentials") t.essentials += m; else t.lifestyle += m;
    t.count++;
  }
  return t;
}

/**
 * Plan inputs (D-65): non-yearly subscriptions enter fixed costs at their monthly equivalent; yearly ones as a monthly
 * set-aside (amount ÷ 12, rounded up so the renewal is covered). Together they are the subscription part of C_fixed;
 * nothing is counted twice.
 */
export function subscriptionFixedCosts(subs: SubForTotals[]): { monthly: number; setAside: number; total: number } {
  let monthly = 0, setAside = 0;
  for (const s of subs) {
    if (!isCharging(s.status)) continue;
    if (s.cycle === "yearly") setAside += annualSetAside(s.expected_sgd_minor);
    else monthly += monthlyEquivalent(s.expected_sgd_minor, s.cycle);
  }
  return { monthly, setAside, total: monthly + setAside };
}
export const annualSetAside = (yearlyAmountMinor: number): number => Math.ceil(yearlyAmountMinor / 12);

/** Next renewal after `date` for a cycle (month ends clamp: 31 Jan + 1 month = 28/29 Feb). */
export function addCycle(date: string, cycle: Cycle, times = 1): string {
  if (cycle === "weekly") return addDays(date, 7 * times);
  const months = (cycle === "monthly" ? 1 : cycle === "quarterly" ? 3 : 12) * times;
  const y = +date.slice(0, 4), m = +date.slice(5, 7), d = +date.slice(8, 10);
  const idx = y * 12 + (m - 1) + months;
  const ny = Math.floor(idx / 12), nm = (idx % 12) + 1;
  const dim = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(d, dim)).padStart(2, "0")}`;
}

// ---------- price changes ----------

/**
 * A charge differs from the expected SGD amount when |diff| > max(2% of expected, S$0.50), plus 3% of expected for
 * foreign-currency charges (FX noise).
 */
export function priceChange(expectedSgd: number, chargedSgd: number, foreign: boolean): { changed: boolean; diff: number; threshold: number } {
  const diff = chargedSgd - expectedSgd;
  const base = Math.max(Math.ceil((expectedSgd * 2) / 100), 50);
  const threshold = base + (foreign ? Math.ceil((expectedSgd * 3) / 100) : 0);
  return { changed: Math.abs(diff) > threshold, diff, threshold };
}

/** "Netflix went from S$19.98 to S$22.98 (+S$36/year)." */
export function priceChangeMessage(name: string, fromSgd: number, toSgd: number, cycle: Cycle): string {
  const yearly = (toSgd - fromSgd) * PER_YEAR[cycle];
  return `${name} went from ${formatMoney(fromSgd)} to ${formatMoney(toSgd)} (${yearly >= 0 ? "+" : "−"}${formatMoneyShort(Math.abs(yearly))}/year).`;
}

// ---------- reminders and flags ----------

/** Expected charge more than 7 days late → quiet flag (no push): it may have been cancelled. */
export const MISSING_AFTER_DAYS = 7;
export function missingCharge(s: { status: SubStatus; next_renewal: string | null }, today: string): boolean {
  return (s.status === "active" || s.status === "cancel_intended") && !!s.next_renewal && addDays(s.next_renewal, MISSING_AFTER_DAYS) < today;
}

/** Free-trial reminder: from 2 days before the trial ends (SGT) until it ends. */
export const TRIAL_REMINDER_DAYS = 2;
export function trialReminderDue(trialEnds: string | null, now: Date | string): boolean {
  if (!trialEnds) return false;
  const today = sgtDate(now);
  return today >= addDays(trialEnds, -TRIAL_REMINDER_DAYS) && today < trialEnds;
}
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** "ChatGPT trial ends Thu — S$28/mo after. Keep / Cancel" */
export function trialReminderBody(name: string, trialEnds: string, priceSgd: number, cycle: Cycle): string {
  const dow = WEEKDAY[new Date(Date.parse(trialEnds)).getUTCDay()];
  const per = cycle === "monthly" ? "mo" : cycle === "yearly" ? "yr" : cycle === "weekly" ? "wk" : "qtr";
  return `${name} trial ends ${dow} — ${formatMoneyShort(priceSgd)}/${per} after. Keep / Cancel`;
}

/** Annual renewals: reminder from 7 days before. */
export const RENEWAL_REMINDER_DAYS = 7;
export function renewalReminderDue(s: { cycle: Cycle; status: SubStatus; next_renewal: string | null }, today: string): boolean {
  return s.cycle === "yearly" && isCharging(s.status) && !!s.next_renewal && today >= addDays(s.next_renewal, -RENEWAL_REMINDER_DAYS) && today < s.next_renewal;
}

/** Quarterly "Still using?" check period, e.g. '2026-Q4'. */
export const quarterOf = (date: string) => `${date.slice(0, 4)}-Q${Math.floor((+date.slice(5, 7) - 1) / 3) + 1}`;

// ---------- matching ----------

/** Does a (normalised) card merchant belong to this subscription's merchant pattern? Exact or prefix. */
export function chargeMatches(merchant: string | null, pattern: string | null): boolean {
  if (!merchant || !pattern) return false;
  const m = normalizeMerchant(merchant), p = normalizeMerchant(pattern);
  return m === p || m.startsWith(p);
}

/** Merging a detected candidate with an existing (e.g. manual) entry: same merchant pattern, or similar name and amount within 15%. */
export function findExistingSubscription<T extends { id: string; name: string; merchant_pattern: string | null; expected_sgd_minor: number; status: SubStatus }>(subs: T[], candidate: { merchant: string; expected_sgd_minor: number }): T | null {
  const live = subs.filter((s) => s.status !== "cancelled");
  const byPattern = live.find((s) => s.merchant_pattern && chargeMatches(candidate.merchant, s.merchant_pattern));
  if (byPattern) return byPattern;
  return live.find((s) => merchantSimilarity(s.name, candidate.merchant) >= 0.5 && Math.abs(s.expected_sgd_minor - candidate.expected_sgd_minor) <= Math.max(100, Math.floor(s.expected_sgd_minor * 0.15))) ?? null;
}

export const APPLE_BILL = /APPLE\.COM\s*\/?\s*BILL/;
export const APPLE_MATCH_DAYS = 3;

/** An Apple receipt matches the APPLE.COM/BILL card charge with the same amount within ±3 days. Closest date wins. */
export function matchAppleReceipt<T extends { id: string; merchant: string | null; amount_minor: number; currency: string; amount_sgd_minor: number; occurred_at: string }>(
  receipt: { amount_minor: number; currency: string; date: string },
  txns: T[],
): T | null {
  const at = Date.parse(receipt.date);
  const ok = txns.filter((t) => {
    if (!t.merchant || !APPLE_BILL.test(t.merchant.toUpperCase())) return false;
    const same = t.currency === receipt.currency ? t.amount_minor === receipt.amount_minor : receipt.currency === "SGD" && t.amount_sgd_minor === receipt.amount_minor;
    return same && Math.abs(Date.parse(t.occurred_at) - at) <= APPLE_MATCH_DAYS * 86400_000;
  });
  return ok.sort((a, b) => Math.abs(Date.parse(a.occurred_at) - at) - Math.abs(Date.parse(b.occurred_at) - at))[0] ?? null;
}

// ---------- cost in goal terms ----------

/** Fractional months until a projection reaches `fv` (linear inside the crossing month); null if not within 50 years. */
export function fractionalMonthsToReach(fv: number, pv: number, pmt: number, returnBp: number): number | null {
  const n = monthsToReach(fv, pv, pmt, returnBp);
  if (n == null || n === 0) return n;
  const before = projectedValue(pv, pmt, returnBp, n - 1), after = projectedValue(pv, pmt, returnBp, n);
  return n - 1 + (after === before ? 1 : (fv - before) / (after - before));
}

/**
 * "S$22.98/mo = S$276/yr. Cancelling moves 'Japan trip' 3 weeks earlier." The monthly amount is added to the goal's pace.
 */
export function goalImpact(monthlyAmount: number, goal: { target: number; value: number; pace: number; returnBp: number }): { weeksEarlier: number | null; reachableOnlyIfCancelled: boolean } {
  const now = fractionalMonthsToReach(goal.target, goal.value, Math.max(0, goal.pace), goal.returnBp);
  const after = fractionalMonthsToReach(goal.target, goal.value, Math.max(0, goal.pace) + monthlyAmount, goal.returnBp);
  if (after == null) return { weeksEarlier: null, reachableOnlyIfCancelled: false };
  if (now == null) return { weeksEarlier: null, reachableOnlyIfCancelled: true };
  return { weeksEarlier: Math.round(((now - after) * 52) / 12), reachableOnlyIfCancelled: false };
}

export function goalImpactText(name: string, monthlyAmount: number, goalName: string, impact: { weeksEarlier: number | null; reachableOnlyIfCancelled: boolean }): string {
  const head = `${formatMoney(monthlyAmount)}/mo = ${formatMoneyShort(monthlyAmount * 12)}/yr.`;
  void name;
  if (impact.reachableOnlyIfCancelled) return `${head} Cancelling would put '${goalName}' within reach at your current pace.`;
  if (!impact.weeksEarlier) return head;
  const w = impact.weeksEarlier;
  return `${head} Cancelling moves '${goalName}' ${w >= 9 ? `${Math.round(w / 4.345)} months` : `${w} week${w === 1 ? "" : "s"}`} earlier.`;
}

// ---------- catalogue ----------

export interface CatalogueItem { key: string; name: string; patterns: string[]; category_id: string; cycle: Cycle; cancel_url: string | null }

/** Small built-in catalogue for manual add (prices are not stored: they vary by plan and change). */
export const CATALOGUE: CatalogueItem[] = [
  { key: "netflix", name: "Netflix", patterns: ["NETFLIX"], category_id: "subscriptions", cycle: "monthly", cancel_url: "https://www.netflix.com/cancelplan" },
  { key: "spotify", name: "Spotify", patterns: ["SPOTIFY"], category_id: "subscriptions", cycle: "monthly", cancel_url: "https://www.spotify.com/account/subscription/" },
  { key: "youtube_premium", name: "YouTube Premium", patterns: ["GOOGLE YOUTUBE", "YOUTUBE"], category_id: "subscriptions", cycle: "monthly", cancel_url: "https://www.youtube.com/paid_memberships" },
  { key: "icloud", name: "iCloud+", patterns: ["APPLE.COM/BILL"], category_id: "subscriptions", cycle: "monthly", cancel_url: "https://support.apple.com/en-sg/118428" },
  { key: "chatgpt", name: "ChatGPT", patterns: ["OPENAI", "CHATGPT"], category_id: "subscriptions", cycle: "monthly", cancel_url: "https://chatgpt.com/#settings/Subscription" },
  { key: "claude", name: "Claude", patterns: ["ANTHROPIC", "CLAUDE.AI"], category_id: "subscriptions", cycle: "monthly", cancel_url: "https://claude.ai/settings/billing" },
  { key: "google_one", name: "Google One", patterns: ["GOOGLE ONE", "GOOGLE STORAGE"], category_id: "subscriptions", cycle: "monthly", cancel_url: "https://one.google.com/settings" },
  { key: "disney_plus", name: "Disney+", patterns: ["DISNEY PLUS", "DISNEYPLUS"], category_id: "subscriptions", cycle: "monthly", cancel_url: "https://www.disneyplus.com/account" },
  { key: "gym", name: "Gym", patterns: [], category_id: "hobbies", cycle: "monthly", cancel_url: null },
  { key: "phone_plan", name: "Phone plan", patterns: ["SINGTEL", "STARHUB", "M1 ", "CIRCLES.LIFE", "GOMO"], category_id: "utilities", cycle: "monthly", cancel_url: null },
];
export const catalogueItem = (key: string | null | undefined) => CATALOGUE.find((c) => c.key === key) ?? null;
