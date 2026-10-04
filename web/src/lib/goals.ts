import { DEFAULT_INFLATION_BP, DEFAULT_RETURN_BP, goalTarget, horizonFor, monthsBetween, retirementTarget, type GoalKind, type GoalState, type Horizon } from "@okanary/core";
import { sgd } from "./format";

/**
 * Pure helpers for the Goals screens (v2 G): wording, grouping, percent <-> basis points. Money is integer minor units,
 * rates are basis points in the API and percentages in the UI. Tone is calm: "behind" is amber at most, never red.
 */

export const DISCLAIMER = "Estimates, not financial advice.";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 'YYYY-MM' (or 'YYYY-MM-DD') -> "Jan 2028". */
export function monthYear(ym: string): string {
  return `${MONTHS[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;
}

// ---------------------------------------------------------------- status

export type ChipTone = "good" | "soft" | "amber";
export interface StatusLike { state: GoalState; surplus: number }

/** Status chip: Reached / On track / Ahead by S$X / Behind. */
export function statusChip(s: StatusLike): { text: string; tone: ChipTone } {
  switch (s.state) {
    case "reached": return { text: "Reached", tone: "good" };
    case "on_track": return { text: "On track", tone: "good" };
    case "ahead": return { text: `Ahead by ${sgd(s.surplus)}`, tone: "good" };
    default: return { text: "Behind", tone: "amber" };
  }
}

export const chipClass: Record<ChipTone, string> = {
  good: "border-mint-line bg-mint-bg text-good",
  soft: "border-line bg-bg text-muted",
  amber: "border-lifestyle bg-pill text-lifestyle-ink",
};

/** "Needs S$450/mo · you're at S$300/mo"; a null pace means there is no earlier snapshot yet. */
export function requiredVsPaceText(required: number, pace: number | null): string {
  const needs = `Needs ${sgd(required)}/mo`;
  return pace == null ? `${needs} · pace: not enough history yet` : `${needs} · you're at ${sgd(Math.max(0, pace))}/mo`;
}

export const plannedText = (plannedMonthly: number | null | undefined): string | null =>
  plannedMonthly != null && plannedMonthly > 0 ? `Plan: ${sgd(plannedMonthly)}/mo` : null;

export const pledgedText = (pledged: number): string | null => (pledged > 0 ? `${sgd(pledged)} pledged, not yet moved` : null);

/** Behind goals: the extra amount per month and when it would finish otherwise. Null for goals that aren't behind. */
export function behindText(s: { state: GoalState; extraMonthly: number; completion: string | null }): string | null {
  if (s.state !== "behind") return null;
  const extra = `+${sgd(s.extraMonthly)}/month to finish on time`;
  return s.completion ? `${extra}, or finish in ${monthYear(s.completion)} at current pace` : `${extra}, or not reached within 50 years at current pace`;
}

/** Progress = value / target, capped to 0..100 (value is transferred + linked value only; pledges are shown apart). */
export function progressPct(value: number, target: number): number {
  if (target <= 0) return value > 0 ? 100 : 0;
  return Math.max(0, Math.min(100, Math.round((value * 100) / target)));
}

// ---------------------------------------------------------------- percent <-> basis points

/** "4.5" or "4.5%" -> 450. Up to 2 decimals, non-negative; anything else (including empty) -> null. */
export function percentToBp(input: string): number | null {
  const s = input.trim().replace(/%$/, "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [i, f = ""] = s.split(".");
  return Number(i) * 100 + Number(f.padEnd(2, "0"));
}

/** 450 -> "4.5", 600 -> "6", 333 -> "3.33" (no % sign). */
export function bpToPercent(bp: number): string {
  const i = Math.trunc(bp / 100);
  const f = String(Math.abs(bp % 100)).padStart(2, "0").replace(/0+$/, "");
  return f ? `${i}.${f}` : String(i);
}

export const percentText = (bp: number): string => `${bpToPercent(bp)}%`;

/** Placeholder in the return field: the default for the horizon that the date (or type) gives. */
export function defaultReturnPercent(kind: GoalKind, targetDate: string | null, today: string): string {
  return bpToPercent(DEFAULT_RETURN_BP[horizonFor(targetDate, today, kind)]);
}

/** Assumptions box: "Return 6% p.a. · Inflation 3% p.a." (inflation only where it applies: mid, long, retirement with a date). */
export function assumptionsText(g: { kind: GoalKind; return_bp: number; return_bp_is_default?: boolean; inflation_bp: number | null; target_date: string | null }): string {
  const ret = `Return ${percentText(g.return_bp)} p.a.${g.return_bp_is_default ? " (default)" : ""}`;
  const inflates = g.kind !== "short" && g.kind !== "emergency" && !!g.target_date;
  return inflates ? `${ret} · Inflation ${percentText(g.inflation_bp ?? DEFAULT_INFLATION_BP)} p.a.` : ret;
}

// ---------------------------------------------------------------- targets

export const inflates = (kind: GoalKind): boolean => kind === "mid" || kind === "long" || kind === "retirement";

/** "S$60,000 today ≈ S$69,556 in 2031" (null when the target doesn't change by the target date). */
export function inflatedText(todayMinor: number, targetMinor: number, targetDate: string | null): string | null {
  if (!targetDate || targetMinor === todayMinor) return null;
  return `${sgd(todayMinor)} today ≈ ${sgd(targetMinor)} in ${targetDate.slice(0, 4)}`;
}

/** Live preview in the editor, same maths as the API (core goalTarget). */
export function previewTarget(i: { kind: GoalKind; todayMinor: number; inflationBp: number | null; targetDate: string | null; today: string }): { target: number; text: string | null } {
  const target = goalTarget({ kind: i.kind, target_today_minor: i.todayMinor, inflation_bp: i.inflationBp, target_date: i.targetDate }, i.today);
  return { target, text: inflates(i.kind) ? inflatedText(i.todayMinor, target, i.targetDate) : null };
}

/** Whole months to the target date, for "N months to go" style text. */
export const monthsToGo = (today: string, targetDate: string | null): number | null => (targetDate ? monthsBetween(today, targetDate) : null);

/** 4% rule helper: desired monthly spending x 12 x 25, labelled as a rule of thumb. */
export function retirementHelperText(monthlyMinor: number): string {
  return `${sgd(monthlyMinor)}/month × 12 × 25 = ${sgd(retirementTarget(monthlyMinor))}: a rule of thumb (4% rule), edit it if you like`;
}

export const INFLATION_HINT = "Education and weddings often rise faster: consider 4–5%";

// ---------------------------------------------------------------- funding

export interface FundingLinkLike { source_type: "nw_account" | "holding" | "earmark"; source_id: string; share_bp: number | null; earmark_minor: number | null }
export interface NameLookup { account: (id: string) => string | undefined; holding: (id: string) => string | undefined }

/** One link: "100% VOO", "50% DBS savings", "S$1,500 in DBS savings". */
export function fundingLinkText(l: FundingLinkLike, names: NameLookup): string {
  if (l.source_type === "earmark") return `${sgd(l.earmark_minor ?? 0)} in ${names.account(l.source_id) ?? "an account that was removed"}`;
  const name = (l.source_type === "holding" ? names.holding(l.source_id) : names.account(l.source_id)) ?? "an item that was removed";
  return `${percentText(l.share_bp ?? 10000)} ${name}`;
}

/** "100% VOO · S$1,500 in DBS savings"; with nothing linked, only transfers you mark as moved count. */
export function fundingSummary(links: FundingLinkLike[], names: NameLookup): string {
  if (links.length === 0) return "No funding linked: counts what you transfer";
  return links.map((l) => fundingLinkText(l, names)).join(" · ");
}

export type WarningLike =
  | { type: "earmark_over"; account_id: string; claimed: number; balance: number }
  | { type: "share_over"; source_type: "nw_account" | "holding"; source_id: string; total_bp: number };

/** Calm wording for over-allocation. */
export function warningText(w: WarningLike, names: NameLookup): string {
  if (w.type === "earmark_over") {
    return `Goals claim ${sgd(w.claimed)} of ${names.account(w.account_id) ?? "an account"}, which holds ${sgd(w.balance)}. Worth a look.`;
  }
  const name = (w.source_type === "holding" ? names.holding(w.source_id) : names.account(w.source_id)) ?? "An item";
  return `Shares of ${name} add up to ${percentText(w.total_bp)}, above 100%. Worth a look.`;
}

// ---------------------------------------------------------------- grouping and order

export const HORIZON_ORDER: Horizon[] = ["short", "mid", "long"];
export const HORIZON_LABEL: Record<Horizon, string> = { short: "Short term (under 2 years)", mid: "Mid term (2–10 years)", long: "Long term (10+ years)" };

/** Group by horizon (short, mid, long), keeping the incoming (priority) order inside each group; empty groups are dropped. */
export function groupByHorizon<T extends { horizon: Horizon }>(goals: T[]): { horizon: Horizon; label: string; items: T[] }[] {
  return HORIZON_ORDER.map((horizon) => ({ horizon, label: HORIZON_LABEL[horizon], items: goals.filter((g) => g.horizon === horizon) })).filter((g) => g.items.length > 0);
}

/**
 * Move a goal one step up/down among the goals of its own group, returning the full id order for POST /goals/reorder
 * (priority is global; the swap is with the neighbour in the same group). Null when it can't move.
 */
export function moveInGroup(goals: { id: string; horizon: Horizon }[], id: string, dir: -1 | 1): string[] | null {
  const i = goals.findIndex((g) => g.id === id);
  if (i < 0) return null;
  const horizon = goals[i]!.horizon;
  let j = i + dir;
  while (j >= 0 && j < goals.length && goals[j]!.horizon !== horizon) j += dir;
  if (j < 0 || j >= goals.length) return null;
  const ids = goals.map((g) => g.id);
  [ids[i], ids[j]] = [ids[j]!, ids[i]!];
  return ids;
}

// ---------------------------------------------------------------- pledges, contributions

export const SOURCE_LABEL: Record<string, string> = {
  underspend: "Last week's underspend", want_skipped: "A want you skipped", commission: "Commission split", manual: "Added by you",
};
export const STATUS_LABEL: Record<string, string> = { pledged: "Pledged", transferred: "Transferred", skipped: "Skipped" };

export function pledgeLabel(p: { source: string; period: string }): string {
  const base = SOURCE_LABEL[p.source] ?? p.source;
  return p.source === "underspend" && /^\d{4}-W\d{2}$/.test(p.period) ? `${base} (${p.period})` : base;
}

/** Emergency fund suggestion card text. */
export function emergencySuggestionText(target: number, months: number): string {
  return `Suggested: emergency fund of ${sgd(target)} (6 × your average Essentials, based on ${months} ${months === 1 ? "month" : "months"})`;
}

// ---------------------------------------------------------------- chart data

/** Date `n` months after `date` ('YYYY-MM-DD'), the day clamped to the month's length. */
export function addMonthsToDate(date: string, n: number): string {
  const y = +date.slice(0, 4), m = +date.slice(5, 7) - 1, d = +date.slice(8, 10);
  const idx = y * 12 + m + n;
  const yy = Math.floor(idx / 12), mm = idx % 12;
  const dim = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  return `${yy}-${String(mm + 1).padStart(2, "0")}-${String(Math.min(d, dim)).padStart(2, "0")}`;
}

export interface ChartPoint { t: number; date: string; actual?: number; projected?: number; band?: [number, number] }

/**
 * Detail chart rows (values in whole dollars for the axis only): the actual snapshot history, then the projected path
 * month by month from today (at most ~`maxPoints` projected points; the last one is always kept). Long goals get a
 * conservative..optimistic band on the projected part.
 */
export function buildChartData(i: {
  today: string; value: number; history: { date: string; value_sgd_minor: number }[]; path: number[];
  cone: { conservative: number[]; optimistic: number[] } | null; maxPoints?: number;
}): ChartPoint[] {
  const d = (minor: number) => minor / 100;
  const t = (date: string) => Date.parse(`${date}T00:00:00Z`);
  const rows: ChartPoint[] = i.history.filter((h) => h.date < i.today).map((h) => ({ t: t(h.date), date: h.date, actual: d(h.value_sgd_minor) }));
  rows.push({ t: t(i.today), date: i.today, actual: d(i.value), projected: d(i.path[0] ?? i.value), ...(i.cone ? { band: [d(i.cone.conservative[0] ?? i.value), d(i.cone.optimistic[0] ?? i.value)] as [number, number] } : {}) });
  const n = i.path.length - 1;
  const step = Math.max(1, Math.ceil(n / (i.maxPoints ?? 120)));
  for (let k = step; k <= n; k += step) pushProjected(rows, i, k, d, t);
  if (n > 0 && (n % step !== 0)) pushProjected(rows, i, n, d, t);
  return rows;
}

function pushProjected(rows: ChartPoint[], i: Parameters<typeof buildChartData>[0], k: number, d: (m: number) => number, t: (s: string) => number) {
  const date = addMonthsToDate(i.today, k);
  rows.push({
    t: t(date), date, projected: d(i.path[k]!),
    ...(i.cone ? { band: [d(i.cone.conservative[k] ?? i.path[k]!), d(i.cone.optimistic[k] ?? i.path[k]!)] as [number, number] } : {}),
  });
}
