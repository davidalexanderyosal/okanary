import { addCycle, dayOfWeek, formatMoney, prettyMerchant, yearlyEquivalent, type Cycle } from "@okanary/core";
import type { SubscriptionInput, SubscriptionItem, SubscriptionSource } from "./api";
import { parseMoneyInput } from "./networth";

/** Pure helpers for the Subscriptions hub page (v2 S). Money is integer minor units; dates are SGT 'YYYY-MM-DD'. */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const day = (ymd: string) => `${+ymd.slice(8, 10)} ${MONTHS[+ymd.slice(5, 7) - 1]}`;

/** "S$129", "S$11.98", "S$5": whole amounts lose the ".00", cents are never rounded away. */
export function moneyText(minor: number, currency = "SGD"): string {
  return formatMoney(minor, currency).replace(/\.00$/, "");
}

const SHORT: Record<Cycle, string> = { weekly: "wk", monthly: "mo", quarterly: "qtr", yearly: "yr" };
const LONG: Record<Cycle, string> = { weekly: "week", monthly: "month", quarterly: "quarter", yearly: "year" };
export const CYCLE_LABEL: Record<Cycle, string> = { weekly: "Weekly", monthly: "Monthly", quarterly: "Quarterly", yearly: "Yearly" };

/** "S$129/yr", "S$11.98/mo", "S$5/wk", "S$30/qtr". */
export function priceCycleText(minor: number, cycle: Cycle, currency = "SGD"): string {
  return `${moneyText(minor, currency)}/${SHORT[cycle]}`;
}

/** "≈ S$10.75/mo" for non-monthly cycles; null when the cycle already is monthly. */
export function monthlyHint(monthlyMinor: number, cycle: Cycle): string | null {
  return cycle === "monthly" ? null : `≈ ${moneyText(monthlyMinor)}/mo`;
}

/** "≈ S$16.20" for a price billed in a foreign currency; null for SGD. */
export function sgdHint(item: Pick<SubscriptionItem, "currency" | "expected_sgd_minor">): string | null {
  return item.currency === "SGD" ? null : `≈ ${moneyText(item.expected_sgd_minor)}`;
}

/** The price as billed: native currency when known, else the SGD amount. */
export function itemPriceText(item: Pick<SubscriptionItem, "amount_minor" | "currency" | "expected_sgd_minor" | "cycle">): string {
  return item.amount_minor != null ? priceCycleText(item.amount_minor, item.cycle, item.currency) : priceCycleText(item.expected_sgd_minor, item.cycle);
}

const SOURCE_LABEL: Record<SubscriptionSource, string> = { detected: "Detected", manual: "Added by you", apple_receipt: "Apple receipt", email_receipt: "Email receipt" };
export const sourceLabel = (s: SubscriptionSource): string => SOURCE_LABEL[s] ?? s;

/** Detected / receipt names often arrive UPPERCASE ("NETFLIX.COM"); typed names are left alone. */
export function displayName(s: { name: string; source: SubscriptionSource }): string {
  const upper = s.name === s.name.toUpperCase() && /[A-Z]/.test(s.name);
  return s.source !== "manual" && upper ? prettyMerchant(s.name) : s.name;
}

// ---------------------------------------------------------------- the texts

/** "New subscription? Spotify S$11.98/month" */
export function candidateText(item: Pick<SubscriptionItem, "name" | "source" | "expected_sgd_minor" | "cycle">): string {
  return `New subscription? ${displayName(item)} ${moneyText(item.expected_sgd_minor)}/${LONG[item.cycle]}`;
}

/** "Netflix went from S$19.98 to S$22.98 (+S$36/year)". Numbers come from the API (expected → pending), a cut reads "−". */
export function priceChangeText(item: Pick<SubscriptionItem, "name" | "source" | "expected_sgd_minor" | "pending_price_sgd_minor" | "cycle">): string | null {
  const to = item.pending_price_sgd_minor;
  if (to == null) return null;
  const yearly = yearlyEquivalent(to - item.expected_sgd_minor, item.cycle);
  return `${displayName(item)} went from ${moneyText(item.expected_sgd_minor)} to ${moneyText(to)} (${yearly >= 0 ? "+" : "−"}${moneyText(Math.abs(yearly))}/year)`;
}

/** "No charge since 5 Oct — maybe cancelled?" (5 Oct = the date the charge was expected). */
export function missingText(item: Pick<SubscriptionItem, "next_renewal">): string {
  return item.next_renewal ? `No charge since ${day(item.next_renewal)} — maybe cancelled?` : "No recent charge — maybe cancelled?";
}

/** "Trial ends Thu — S$28/mo after" */
export function trialText(item: Pick<SubscriptionItem, "trial_ends" | "expected_sgd_minor" | "cycle">): string {
  const dow = item.trial_ends ? WEEKDAYS[dayOfWeek(item.trial_ends)] : null;
  return `Trial ends${dow ? ` ${dow}` : ""} — ${priceCycleText(item.expected_sgd_minor, item.cycle)} after`;
}

/** "Renews 1 Nov: S$129" */
export function renewalText(item: Pick<SubscriptionItem, "next_renewal" | "expected_sgd_minor">): string {
  return `Renews ${item.next_renewal ? day(item.next_renewal) : "soon"}: ${moneyText(item.expected_sgd_minor)}`;
}

export type FlagKind = "price_change" | "missing" | "trial_ending" | "renewal_soon";
export interface FlagLine { kind: FlagKind; text: string }

/** The flag lines of one item, most important first (calm wording: a price rise or a missing charge is information, not an alarm). */
export function flagLines(item: SubscriptionItem): FlagLine[] {
  const out: FlagLine[] = [];
  const pc = item.flags.price_change ? priceChangeText(item) : null;
  if (pc) out.push({ kind: "price_change", text: pc });
  if (item.flags.trial_ending) out.push({ kind: "trial_ending", text: trialText(item) });
  if (item.flags.missing) out.push({ kind: "missing", text: missingText(item) });
  if (item.flags.renewal_soon) out.push({ kind: "renewal_soon", text: renewalText(item) });
  return out;
}

/** "Renews 1 Nov", "Trial ends 9 Oct", "Next around 12 Nov" line of a card; null when no date is known. */
export function nextLine(item: Pick<SubscriptionItem, "status" | "next_renewal" | "trial_ends" | "source">): string | null {
  if (item.status === "trial" && item.trial_ends) return `Trial ends ${day(item.trial_ends)}`;
  if (!item.next_renewal) return null;
  return `${item.source === "detected" ? "Next around" : "Renews"} ${day(item.next_renewal)}`;
}

// ---------------------------------------------------------------- sections

export interface Sections {
  candidate: SubscriptionItem[]; attention: SubscriptionItem[]; active: SubscriptionItem[]; cancelling: SubscriptionItem[]; ended: SubscriptionItem[];
}

/**
 * candidate → "To confirm"; active/trial with a flag → "Needs a look" (never also in Active); other active/trial → "Active";
 * cancel_intended → "Cancelling"; cancelled/dismissed → "Cancelled / dismissed". API order is kept inside each section.
 */
export function groupSubscriptions(items: SubscriptionItem[]): Sections {
  const out: Sections = { candidate: [], attention: [], active: [], cancelling: [], ended: [] };
  for (const s of items) {
    if (s.status === "candidate") out.candidate.push(s);
    else if (s.status === "cancel_intended") out.cancelling.push(s);
    else if (s.status === "cancelled" || s.status === "dismissed") out.ended.push(s);
    else if (flagLines(s).length > 0) out.attention.push(s);
    else out.active.push(s);
  }
  return out;
}

/** Items for the "Still using?" check: charging and not yet answered. */
export const stillUsingList = (items: SubscriptionItem[], answered: ReadonlySet<string>): SubscriptionItem[] =>
  items.filter((s) => s.status === "active" && !answered.has(s.id));

// ---------------------------------------------------------------- dates

/** Default next renewal for a new subscription: one cycle after `today` (SGT date). */
export const defaultNextRenewal = (cycle: Cycle, today: string): string => addCycle(today, cycle);

/** After "Keep" on a missing charge: the first renewal date after `today`, stepping whole cycles from the expected date. */
export function rollForwardRenewal(next: string, cycle: Cycle, today: string): string {
  let k = 0;
  let d = next;
  while (d <= today && k < 1000) d = addCycle(next, cycle, ++k);
  return d;
}

// ---------------------------------------------------------------- the add / edit form

export interface SubForm {
  name: string; catalogueKey: string | null; price: string; currency: string; cycle: Cycle; nextRenewal: string;
  accountId: string; categoryId: string; trial: boolean; trialEnds: string;
}

/**
 * Form → API body, or an error message. Create sends everything; edit sends only what changed (so an untouched price keeps
 * its expected SGD amount and a pending price-change flag). A trial's first charge is the day it ends; price = price after the trial.
 */
export function buildPayload(f: SubForm, original: SubscriptionItem | null): { input: SubscriptionInput } | string {
  const name = f.name.trim();
  if (!name) return "Give it a name.";
  const amount = parseMoneyInput(f.price, f.currency);
  if (amount == null || amount < 1) return "Enter the price, above zero.";
  if (f.trial && !/^\d{4}-\d{2}-\d{2}$/.test(f.trialEnds)) return "Pick the day the trial ends.";
  const nextRenewal = f.trial ? f.trialEnds : f.nextRenewal;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(nextRenewal)) return "Pick the next renewal date.";

  if (!original) {
    const input: SubscriptionInput = {
      name, catalogue_key: f.catalogueKey, amount_minor: amount, currency: f.currency, cycle: f.cycle, next_renewal: nextRenewal,
      trial_ends: f.trial ? f.trialEnds : null, status: f.trial ? "trial" : "active",
    };
    if (f.accountId) input.account_id = f.accountId;
    if (f.categoryId) input.category_id = f.categoryId;
    return { input };
  }

  const input: SubscriptionInput = {};
  const oldAmount = original.amount_minor ?? original.expected_sgd_minor;
  if (name !== original.name) input.name = name;
  if (amount !== oldAmount || f.currency !== original.currency) { input.amount_minor = amount; input.currency = f.currency; }
  if (f.cycle !== original.cycle) input.cycle = f.cycle;
  if (nextRenewal !== original.next_renewal) input.next_renewal = nextRenewal;
  if (f.accountId !== (original.account_id ?? "")) input.account_id = f.accountId || null;
  if (f.categoryId && f.categoryId !== original.category_id) input.category_id = f.categoryId;
  const wasTrial = original.status === "trial";
  if (f.trial) {
    if (f.trialEnds !== original.trial_ends) input.trial_ends = f.trialEnds;
    if (!wasTrial) input.status = "trial";
  } else if (wasTrial) {
    input.trial_ends = null;
    input.status = "active";
  }
  return { input };
}
