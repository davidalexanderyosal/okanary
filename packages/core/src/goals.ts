import { applyBp } from "./decimal";
import { formatMoneyShort } from "./money";

/**
 * Goals (v2 feature G): targets, projection, status, funding value and pledges. Pure and deterministic.
 * Growth maths needs real exponents, so rates are JS numbers; every MONEY output is rounded to integer minor units.
 *   r = (1 + annual)^(1/12) − 1        monthly rate from an annual rate in basis points
 *   PMT_req = (FV − PV·(1+r)^n) · r / ((1+r)^n − 1)      (r = 0: (FV − PV)/n), floored at 0, rounded UP to the cent
 *   FV_proj = PV·(1+r)^n + PMT · ((1+r)^n − 1)/r        (r = 0: PV + PMT·n)
 */

export type GoalKind = "emergency" | "short" | "mid" | "long" | "retirement";
export type Horizon = "short" | "mid" | "long";
export type GoalState = "reached" | "on_track" | "ahead" | "behind";

export const DEFAULT_RETURN_BP: Record<Horizon, number> = { short: 200, mid: 400, long: 600 };
export const DEFAULT_INFLATION_BP = 300;
/** Long goals show conservative / base / optimistic at return −2 / base / +2 percentage points. */
export const RANGE_SPREAD_BP = 200;
/** "not reached within 50 years" */
export const MAX_PROJECTION_MONTHS = 600;
/** Projected at least this far above target reads "ahead" (D-58). */
export const AHEAD_MARGIN_PCT = 5;
export const EMERGENCY_MONTHS = 6;

export const monthlyRate = (annualBp: number): number => (annualBp === 0 ? 0 : Math.pow(1 + annualBp / 10000, 1 / 12) - 1);

const ymd = (d: string) => ({ y: +d.slice(0, 4), m: +d.slice(5, 7), d: +d.slice(8, 10) });

/** Whole months from `from` to `to` ('YYYY-MM-DD'); a partial month doesn't count. Never negative. */
export function monthsBetween(from: string, to: string): number {
  const a = ymd(from), b = ymd(to);
  const n = (b.y - a.y) * 12 + (b.m - a.m) - (b.d < a.d ? 1 : 0);
  return Math.max(0, n);
}

/** 'YYYY-MM' n months after the month of `date`. */
export function monthAfter(date: string, n: number): string {
  const { y, m } = ymd(date);
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

/** Short < 2 years, mid 2–10 years, long ≥ 10 years to the target date. Without a date: by kind. */
export function horizonFor(targetDate: string | null, today: string, kind: GoalKind = "short"): Horizon {
  if (!targetDate) return kind === "emergency" || kind === "short" ? "short" : kind === "mid" ? "mid" : "long";
  const n = monthsBetween(today, targetDate);
  return n < 24 ? "short" : n < 120 ? "mid" : "long";
}

/** today's dollars → dollars at the target date: today × (1 + i)^(months/12). */
export function inflateTarget(todayMinor: number, inflationBp: number, months: number): number {
  return Math.round(todayMinor * Math.pow(1 + inflationBp / 10000, Math.max(0, months) / 12));
}

/** Short and emergency goals are fixed amounts; mid/long/retirement are entered in today's dollars and inflated. */
export function goalTarget(g: { kind: GoalKind; target_today_minor: number; inflation_bp: number | null; target_date: string | null }, today: string): number {
  if (g.kind === "short" || g.kind === "emergency" || !g.target_date) return g.target_today_minor;
  return inflateTarget(g.target_today_minor, g.inflation_bp ?? DEFAULT_INFLATION_BP, monthsBetween(today, g.target_date));
}

/** "4% rule" helper: desired monthly spending (today's dollars) × 12 × 25. A rule of thumb, shown as editable. */
export const retirementTarget = (monthlySpendMinor: number): number => monthlySpendMinor * 12 * 25;

/** Emergency fund = 6 × average monthly Essentials spend (from actual spending). */
export const emergencyTarget = (avgMonthlyEssentials: number | null): number | null => (avgMonthlyEssentials == null ? null : Math.max(0, avgMonthlyEssentials) * EMERGENCY_MONTHS);

const growth = (r: number, n: number) => Math.pow(1 + r, n);

export function requiredMonthly(fv: number, pv: number, annualBp: number, n: number): number {
  if (pv >= fv) return 0;
  if (n <= 0) return fv - pv; // due now: the whole gap
  const r = monthlyRate(annualBp);
  const raw = r === 0 ? (fv - pv) / n : ((fv - pv * growth(r, n)) * r) / (growth(r, n) - 1);
  return Math.max(0, Math.ceil(raw - 1e-9));
}

export function projectedValue(pv: number, pmt: number, annualBp: number, n: number): number {
  const r = monthlyRate(annualBp);
  const m = Math.max(0, n);
  return Math.round(r === 0 ? pv + pmt * m : pv * growth(r, m) + (pmt * (growth(r, m) - 1)) / r);
}

/** Months until the projected value first reaches `fv` at this pace; null if not within 50 years. */
export function monthsToReach(fv: number, pv: number, pmt: number, annualBp: number, max = MAX_PROJECTION_MONTHS): number | null {
  if (pv >= fv) return 0;
  if (pmt <= 0 && (annualBp <= 0 || pv <= 0)) return null;
  for (let n = 1; n <= max; n++) if (projectedValue(pv, pmt, annualBp, n) >= fv) return n;
  return null;
}

export interface GoalStatus {
  state: GoalState;
  target: number;
  value: number;
  monthsLeft: number;
  required: number;
  pace: number;
  projected: number;
  /** behind: extra per month needed to finish on time */
  extraMonthly: number;
  /** projected completion month at the current pace ('YYYY-MM'), null when not within 50 years */
  completion: string | null;
  /** ahead/on track: projected − target */
  surplus: number;
}

/**
 * On track: projected value at the target date ≥ target. Ahead: ≥ 5% above target. Behind: below target, with
 * "+S$X/month to finish on time" (required − pace) and "or finish in MMM YYYY at current pace". Reached: value ≥ target.
 * Goals without a date use a 12-month horizon for the arithmetic.
 */
export function goalStatus(i: { target: number; value: number; pace: number; returnBp: number; targetDate: string | null; today: string }): GoalStatus {
  const monthsLeft = i.targetDate ? monthsBetween(i.today, i.targetDate) : 12;
  const required = requiredMonthly(i.target, i.value, i.returnBp, monthsLeft);
  const projected = projectedValue(i.value, i.pace, i.returnBp, monthsLeft);
  const toReach = monthsToReach(i.target, i.value, i.pace, i.returnBp);
  const completion = toReach == null ? null : monthAfter(i.today, toReach);
  const base = { target: i.target, value: i.value, monthsLeft, required, pace: i.pace, projected, completion };
  if (i.value >= i.target) return { ...base, state: "reached", extraMonthly: 0, surplus: i.value - i.target };
  if (projected >= i.target) {
    const ahead = (projected - i.target) * 100 >= AHEAD_MARGIN_PCT * i.target;
    return { ...base, state: ahead ? "ahead" : "on_track", extraMonthly: 0, surplus: projected - i.target };
  }
  return { ...base, state: "behind", extraMonthly: Math.max(0, required - Math.max(0, i.pace)), surplus: projected - i.target };
}

/** Conservative / base / optimistic projected values at the target date (return −2 / base / +2 pp, never below 0%). */
export function projectionRange(pv: number, pmt: number, returnBp: number, n: number): { conservative: number; base: number; optimistic: number } {
  return {
    conservative: projectedValue(pv, pmt, Math.max(0, returnBp - RANGE_SPREAD_BP), n),
    base: projectedValue(pv, pmt, returnBp, n),
    optimistic: projectedValue(pv, pmt, returnBp + RANGE_SPREAD_BP, n),
  };
}

/** Projected path month by month (0..n) for the chart; long goals get the range as a cone. */
export function projectionPath(pv: number, pmt: number, returnBp: number, n: number): number[] {
  return Array.from({ length: Math.max(0, n) + 1 }, (_, k) => projectedValue(pv, pmt, returnBp, k));
}

// ---------- funding (integration with N) ----------

export type FundingType = "nw_account" | "holding" | "earmark";
export interface FundingLink { goal_id: string; source_type: FundingType; source_id: string; share_bp: number | null; earmark_minor: number | null }
export interface ValueLookup {
  /** SGD value of a net-worth account (its balance incl. holdings), null if unknown */
  account: (id: string) => number | null;
  /** SGD value of one holding */
  holding: (id: string) => number | null;
}

export interface GoalValue {
  value: number;
  linked: number;
  earmarked: number;
  contributions: number;
  /** contributions count toward the value only for goals without share links (C11 / D-59) */
  countsContributions: boolean;
}

/**
 * Goal value = Σ share-linked accounts/holdings (value × share) + Σ earmarks + (no share links ? transferred contributions : 0).
 * Pledged contributions never count (progress counts transferred money only).
 */
export function goalValue(links: FundingLink[], values: ValueLookup, transferredTotal: number): GoalValue {
  let linked = 0, earmarked = 0, shareLinks = 0;
  for (const l of links) {
    if (l.source_type === "earmark") { earmarked += Math.max(0, l.earmark_minor ?? 0); continue; }
    shareLinks++;
    const v = l.source_type === "holding" ? values.holding(l.source_id) : values.account(l.source_id);
    if (v != null) linked += applyBp(v, l.share_bp ?? 10000);
  }
  const countsContributions = shareLinks === 0;
  return { value: linked + earmarked + (countsContributions ? transferredTotal : 0), linked, earmarked, contributions: transferredTotal, countsContributions };
}

export type FundingWarning =
  | { type: "earmark_over"; account_id: string; claimed: number; balance: number }
  | { type: "share_over"; source_type: "nw_account" | "holding"; source_id: string; total_bp: number };

/**
 * Across ALL goals: shares of one holding/account can't exceed 100%, and earmarks on an account (plus any share of it
 * claimed by other goals) can't exceed its balance.
 */
export function fundingWarnings(links: FundingLink[], values: ValueLookup): FundingWarning[] {
  const out: FundingWarning[] = [];
  const shares = new Map<string, { source_type: "nw_account" | "holding"; source_id: string; bp: number }>();
  const claims = new Map<string, number>();
  for (const l of links) {
    if (l.source_type === "earmark") { claims.set(l.source_id, (claims.get(l.source_id) ?? 0) + Math.max(0, l.earmark_minor ?? 0)); continue; }
    const k = `${l.source_type}:${l.source_id}`;
    const s = shares.get(k) ?? { source_type: l.source_type, source_id: l.source_id, bp: 0 };
    s.bp += l.share_bp ?? 10000;
    shares.set(k, s);
  }
  for (const s of shares.values()) if (s.bp > 10000) out.push({ type: "share_over", source_type: s.source_type, source_id: s.source_id, total_bp: s.bp });
  for (const [acct, earmarks] of claims) {
    const bal = values.account(acct) ?? 0;
    const shared = shares.get(`nw_account:${acct}`);
    const claimed = earmarks + (shared ? applyBp(bal, Math.min(shared.bp, 10000)) : 0);
    if (claimed > bal) out.push({ type: "earmark_over", account_id: acct, claimed, balance: bal });
  }
  return out;
}

/**
 * Current pace (C12 / D-60): net monthly contribution over the last 3 months, market movement excluded:
 *   (value now − value at the baseline − market movement on the goal's links since the baseline) ÷ months.
 * baseline = the latest goal snapshot on/before (today − 3 months), else the earliest one; months = elapsed time in months
 * (min 1, max 3). Without any earlier snapshot the pace is unknown (null → treated as 0).
 */
export function goalPace(i: { valueNow: number; baseline: { date: string; value: number } | null; marketSinceBaseline: number; today: string }): number | null {
  if (!i.baseline || i.baseline.date >= i.today) return null;
  const days = (Date.parse(i.today) - Date.parse(i.baseline.date)) / 86400_000;
  const months = Math.min(3, Math.max(1, days / (365.25 / 12)));
  return Math.round((i.valueNow - i.baseline.value - i.marketSinceBaseline) / months);
}

/** Date 3 months before `today` (clamped day), the start of the pace window. */
export function paceWindowStart(today: string): string {
  const { d } = ymd(today);
  const m = monthAfter(today, -3);
  const dim = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).getUTCDate();
  return `${m}-${String(Math.min(d, dim)).padStart(2, "0")}`;
}

/** Totals of a goal's contributions: progress counts transferred only; pledged is shown apart. */
export function contributionTotals(rows: { amount_sgd_minor: number; status: "pledged" | "transferred" | "skipped" }[]): { transferred: number; pledged: number; skipped: number } {
  const t = { transferred: 0, pledged: 0, skipped: 0 };
  for (const r of rows) t[r.status] += r.amount_sgd_minor;
  return t;
}

// ---------- horizon changes ----------

/** "Move to safer funding?" once, when a goal crosses below 2 years while funded from stocks/crypto. */
export function saferFundingPrompt(prev: Horizon | null, next: Horizon, hasRiskyFunding: boolean): boolean {
  return next === "short" && prev != null && prev !== "short" && hasRiskyFunding;
}

// ---------- pledges ----------

/** Weekly underspend from A: max(0, allowance − Lifestyle spent) for the week that just ended. */
export const underspendAmount = (allowanceTotal: number, lifestyleSpent: number): number => Math.max(0, allowanceTotal - lifestyleSpent);

export interface GoalForPledge { id: string; priority: number; archived: number; receives_underspend: number; state: GoalState }

/**
 * The goal that receives underspend pledges: the one marked receives_underspend; by default (none marked) the
 * highest-priority goal that is behind. None → no pledge.
 */
export function underspendGoal(goals: GoalForPledge[]): GoalForPledge | null {
  const live = goals.filter((g) => !g.archived);
  const marked = live.find((g) => g.receives_underspend);
  if (marked) return marked;
  return [...live].filter((g) => g.state === "behind").sort((a, b) => a.priority - b.priority)[0] ?? null;
}

/** Waterfall in priority order: fill each goal's need from `amount`; returns allocations (only > 0) and what's left. */
export function waterfall(amount: number, needs: { id: string; priority: number; need: number }[]): { allocations: { id: string; amount: number }[]; left: number } {
  let left = Math.max(0, amount);
  const allocations: { id: string; amount: number }[] = [];
  for (const n of [...needs].sort((a, b) => a.priority - b.priority)) {
    if (left <= 0) break;
    const a = Math.min(left, Math.max(0, n.need));
    if (a > 0) { allocations.push({ id: n.id, amount: a }); left -= a; }
  }
  return { allocations, left };
}

/**
 * Market movement on a goal's share links over a series of snapshots (from N's per-item market maps, in date order):
 * a linked account counts its own balance AND its holdings; a linked holding counts itself; × share. Earmarks never move.
 */
export function linkedMarket(links: FundingLink[], perDay: Map<string, number>[], holdingAccount: (holdingId: string) => string | null): number {
  let total = 0;
  for (const day of perDay) {
    for (const [key, m] of day) {
      const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
      for (const l of links) {
        if (l.source_type === "earmark") continue;
        const hit = l.source_type === "holding" ? kind === "holding" && l.source_id === id : (kind === "account" && l.source_id === id) || (kind === "holding" && holdingAccount(id) === l.source_id);
        if (hit) total += applyBp(m, l.share_bp ?? 10000);
      }
    }
  }
  return total;
}

/** Home line: "Goals: 4 on track · 1 behind (MBA −S$120/mo)". On track counts on_track, ahead and reached. */
export function goalsSummaryLine(goals: { name: string; priority: number; status: Pick<GoalStatus, "state" | "extraMonthly"> }[]): string | null {
  if (goals.length === 0) return null;
  const ok = goals.filter((g) => g.status.state !== "behind").length;
  const behind = goals.filter((g) => g.status.state === "behind").sort((a, b) => a.priority - b.priority);
  const parts = [`${ok} on track`];
  if (behind.length) {
    const first = behind[0]!;
    parts.push(`${behind.length} behind (${first.name} −${formatMoneyShort(first.status.extraMonthly)}/mo${behind.length > 1 ? ", …" : ""})`);
  }
  return `Goals: ${parts.join(" · ")}`;
}
