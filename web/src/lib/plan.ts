import { DEFAULT_SPLIT, percentages, prettyMerchant, sgtDate, weeklyFromMonthly, type CommissionSplit, type FixedLine, type PlanOutput, type SplitRule, type TradeOff } from "@okanary/core";
import type { IncomeCandidate, IncomeEvent, IncomeKind, PlanFull, PlanResponse } from "./api";
import { sgd, shortDate } from "./format";
import { bpToPercent, monthYear } from "./goals";

/**
 * Pure helpers for the Plan tab and its onboarding wizard (v2 P): bar segments, wording, wizard step logic.
 * Money is integer SGD minor units. Tone is calm: an infeasible plan "doesn't fit yet", never an alarm, never red.
 */

export const DISCLAIMER = "Estimates, not financial advice.";

// ---------------------------------------------------------------- amounts

/** "S$700/month (≈ S$162/week)": a monthly Lifestyle amount with the weekly allowance it implies. */
export const monthlyWeeklyText = (monthly: number, weekly: number): string => `${sgd(monthly)}/month (≈ ${sgd(weekly)}/week)`;

/** Weekly allowance of a monthly Lifestyle amount in `month` (monthly × 7 ÷ days in month). */
export const lifestyleText = (monthly: number, month: string): string => monthlyWeeklyText(monthly, weeklyFromMonthly(monthly, month));

/** "≈ S$162/week": the weekly allowance a monthly Lifestyle amount implies in `month`. */
export const weeklyText = (monthly: number, month: string): string => `≈ ${sgd(weeklyFromMonthly(monthly, month))}/week`;

/** Toast / confirmation after accepting: "Your Lifestyle budget is now S$X/month (≈ S$Y/week)". */
export const acceptedText = (monthly: number, month: string): string => `Your Lifestyle budget is now ${lifestyleText(monthly, month)}`;

// ---------------------------------------------------------------- stacked bar

export type SegmentKey = "fixed" | "goals" | "lifestyle" | "unallocated";
export interface BarSegment { key: SegmentKey; label: string; amount: number; /** whole percent of the bar, the shown segments sum to 100 */ pct: number }

/** Fixed / goals / Lifestyle (+ unallocated savings when there is any) as bar segments; widths in % sum to exactly 100. */
export function splitBarSegments(plan: Pick<PlanOutput, "fixed" | "goals" | "lifestyle" | "unallocated">): BarSegment[] {
  const parts: { key: SegmentKey; label: string; amount: number }[] = [
    { key: "fixed", label: "Fixed", amount: plan.fixed.total },
    { key: "goals", label: "Goals", amount: plan.goals.total },
    { key: "lifestyle", label: "Lifestyle", amount: plan.lifestyle },
    { key: "unallocated", label: "Unallocated savings", amount: plan.unallocated },
  ];
  const pcts = percentages(parts.map((p) => p.amount));
  return parts.map((p, i) => ({ ...p, pct: pcts[i]! })).filter((s) => s.amount > 0);
}

/** "For reference: 50/30/20 · 60/20/20 (Singapore)" (benchmarks, not targets). */
export const referenceText = (refs: { name: string }[]): string => `For reference: ${refs.map((r) => r.name).join(" · ")}`;

/** Shown when Lifestyle sits at its cap: "Capped at your usual + 10%; the rest goes to goals." */
export function capNote(plan: Pick<PlanOutput, "feasible" | "cap" | "available" | "unallocated">, capPct: number): string | null {
  if (!plan.feasible || plan.cap == null || plan.available <= plan.cap) return null;
  const base = `Capped at your usual + ${capPct}%; the rest goes to goals.`;
  return plan.unallocated > 0 ? `${base} ${sgd(plan.unallocated)} is left over once every goal is covered.` : base;
}

// ---------------------------------------------------------------- income

const KIND_LABEL: Record<IncomeKind, string> = { commission: "Commission", bonus: "Bonus", other: "Other income" };
export const incomeKindLabel = (k: IncomeKind): string => KIND_LABEL[k];

/** Commission and bonus logged in `month` (SGT 'YYYY-MM'), whatever the split decision. */
export function commissionThisMonth(events: Pick<IncomeEvent, "kind" | "amount_minor" | "received_on">[], month: string): number {
  return events.filter((e) => (e.kind === "commission" || e.kind === "bonus") && e.received_on.startsWith(month)).reduce((a, e) => a + e.amount_minor, 0);
}

/** Events whose split is waiting for Confirm / Skip. */
export const proposedEvents = (events: IncomeEvent[]): IncomeEvent[] => events.filter((e) => e.split_status === "proposed" && e.split != null);

/** "Commission S$900 · 3 Oct" */
export const eventLabel = (e: Pick<IncomeEvent, "kind" | "amount_minor" | "received_on">): string => `${incomeKindLabel(e.kind)} ${sgd(e.amount_minor)} · ${shortDate(e.received_on)}`;

/** "Bonus Co · 28 Sep · S$900" for an Income transaction that can be logged. */
export function candidateLabel(c: Pick<IncomeCandidate, "merchant" | "occurred_at" | "amount_sgd_minor">): string {
  return `${prettyMerchant(c.merchant) || "Income"} · ${shortDate(sgtDate(c.occurred_at))} · ${sgd(c.amount_sgd_minor)}`;
}

/**
 * "S$700 to goals: Japan S$400, MBA S$300 · S$200 guilt-free this week · S$100 buffer → Emergency fund".
 * `nameOf` resolves a goal id; an unknown (archived) goal reads "a goal".
 */
export function commissionSplitText(split: Pick<CommissionSplit, "goals" | "fun" | "buffer" | "pledges" | "unallocated">, nameOf: (id: string) => string | undefined): string {
  const name = (id: string) => nameOf(id) ?? "a goal";
  const sum = (part: "goals" | "buffer") => {
    const m = new Map<string, number>();
    for (const p of split.pledges) if (p.part === part) m.set(p.goal_id, (m.get(p.goal_id) ?? 0) + p.amount);
    return [...m.entries()];
  };
  const out: string[] = [];
  if (split.goals > 0) {
    const g = sum("goals");
    out.push(`${sgd(split.goals)} to goals${g.length ? `: ${g.map(([id, a]) => `${name(id)} ${sgd(a)}`).join(", ")}` : ""}`);
  }
  if (split.fun > 0) out.push(`${sgd(split.fun)} guilt-free this week`);
  if (split.buffer > 0) {
    const b = sum("buffer");
    out.push(`${sgd(split.buffer)} buffer${b.length ? ` → ${b.map(([id]) => name(id)).join(", ")}` : ""}`);
  }
  if (split.unallocated > 0) out.push(`${sgd(split.unallocated)} has no goal to fill yet`);
  return out.join(" · ");
}

// ---------------------------------------------------------------- commission split rule

/** "Commission split: 70% goals · 20% guilt-free · 10% buffer" (basis points → percent). */
export const splitRuleText = (r: SplitRule): string =>
  `Commission split: ${bpToPercent(r.goals_bp)}% goals · ${bpToPercent(r.fun_bp)}% guilt-free · ${bpToPercent(r.buffer_bp)}% buffer`;

export interface SplitPercents { goals: string; fun: string; buffer: string }

/** The rule as the text of three percent inputs. */
export const splitRuleToPercents = (r: SplitRule): SplitPercents => ({ goals: bpToPercent(r.goals_bp), fun: bpToPercent(r.fun_bp), buffer: bpToPercent(r.buffer_bp) });

const wholePercent = (s: string): number | null => (/^\d{1,3}$/.test(s.trim()) && Number(s) <= 100 ? Number(s) : null);

/** Running total of the three inputs; a blank or invalid one counts as 0. */
export const splitPercentsTotal = (p: SplitPercents): number => [p.goals, p.fun, p.buffer].reduce((a, s) => a + (wholePercent(s) ?? 0), 0);

/** Whole percents → basis points (percent × 100); null unless all three are whole numbers 0..100 adding up to exactly 100. */
export function splitRuleFromPercents(p: SplitPercents): SplitRule | null {
  const [g, f, b] = [wholePercent(p.goals), wholePercent(p.fun), wholePercent(p.buffer)];
  if (g == null || f == null || b == null || g + f + b !== 100) return null;
  return { goals_bp: g * 100, fun_bp: f * 100, buffer_bp: b * 100 };
}

export const DEFAULT_SPLIT_PERCENTS: SplitPercents = splitRuleToPercents(DEFAULT_SPLIT);

// ---------------------------------------------------------------- trade-offs

/** "Japan trip: Oct 2027 → Aug 2028" */
export const extendChangeText = (c: { name: string; from: string | null; to: string }): string => `${c.name}: ${c.from ? monthYear(c.from) : "no date"} → ${monthYear(c.to)}`;

/** "Behind goals need S$X/month; covered if commission averages ≥ S$Y/month (now S$Z)." */
export function commissionTradeOffText(t: { shortfall: number; commissionNeeded: number; averageCommission: number; covered: boolean }): string {
  const base = `Behind goals need ${sgd(t.shortfall)}/month; covered if commission averages ≥ ${sgd(t.commissionNeeded)}/month (now ${sgd(t.averageCommission)})`;
  return t.covered ? `${base}. Your average already covers it.` : `${base}.`;
}

export interface TradeOffCard { kind: TradeOff["kind"]; title: string; lines: string[]; note: string | null; /** the extend card offers "Use these dates" */ canUse: boolean }

/** Calm option cards for an infeasible plan; an extend option with no date changes is left out. */
export function tradeOffCards(tradeOffs: TradeOff[]): TradeOffCard[] {
  const cards: TradeOffCard[] = [];
  for (const t of tradeOffs) {
    if (t.kind === "extend") {
      if (t.changes.length === 0) continue;
      cards.push({
        kind: "extend", title: "Push back goals", lines: t.changes.map(extendChangeText), canUse: true,
        note: t.covers ? null : "Even with these dates it's a little short. You can combine options.",
      });
    } else if (t.kind === "lower_lifestyle") {
      cards.push({ kind: "lower_lifestyle", title: `Lower Lifestyle to ${monthlyWeeklyText(t.lifestyle, t.weekly)}`, lines: [], note: "Keeps every goal on its date.", canUse: false });
    } else {
      cards.push({ kind: "commission", title: "Use commission", lines: [commissionTradeOffText(t)], note: "Commission still never raises your regular Lifestyle budget.", canUse: false });
    }
  }
  return cards;
}

/** Intro above the option cards. Never alarming. */
export function infeasibleText(plan: Pick<PlanOutput, "available" | "floor">): string {
  const left = Math.max(0, plan.available);
  return `Your fixed costs and goals leave ${sgd(left)}/month for Lifestyle, and a comfortable floor is ${sgd(plan.floor)}. It doesn't fit yet, but here are some options.`;
}

// ---------------------------------------------------------------- budget source, Home

/** When the Lifestyle budget was set by hand: "Your Lifestyle budget was set by hand (S$X); the plan suggests S$Y". */
export function budgetSourceNote(source: PlanFull["budget_source"], budget: number | null, planLifestyle: number): string | null {
  if (source !== "manual" || budget == null) return null;
  return `Your Lifestyle budget was set by hand (${sgd(budget)}); the plan suggests ${sgd(planLifestyle)}`;
}

/** Home's single plan line, only once a plan was accepted for the month: "Plan: S$X/mo Lifestyle · S$Y/mo to goals". */
export function homePlanLine(p: PlanResponse | undefined): string | null {
  if (!p || p.needs_income || !p.accepted) return null;
  const o = p.accepted.outputs;
  return `Plan: ${sgd(o.lifestyle)}/mo Lifestyle · ${sgd(o.goals.total)}/mo to goals`;
}

/** True when the accepted plan still says what today's plan says (Lifestyle, fixed and goals totals), so there is nothing new to accept. */
export function planMatchesAccepted(plan: Pick<PlanOutput, "lifestyle" | "fixed" | "goals">, accepted: Pick<PlanOutput, "lifestyle" | "fixed" | "goals">): boolean {
  return plan.lifestyle === accepted.lifestyle && plan.fixed.total === accepted.fixed.total && plan.goals.total === accepted.goals.total;
}

// ---------------------------------------------------------------- assumptions

export function floorLine(plan: Pick<PlanOutput, "floor">, floorOverride: number | null | undefined, floorPct: number): string {
  if (floorOverride != null) return `Lifestyle floor: ${sgd(floorOverride)}/month (set by you)`;
  return plan.floor > 0 ? `Lifestyle floor: ${floorPct}% of your usual (${sgd(plan.floor)}/month)` : `Lifestyle floor: ${floorPct}% of your usual (needs a few months of history)`;
}

export function capLine(plan: Pick<PlanOutput, "cap">, capPct: number): string {
  return plan.cap != null ? `Lifestyle cap: your usual + ${capPct}% (${sgd(plan.cap)}/month)` : `Lifestyle cap: your usual + ${capPct}% (needs a few months of history)`;
}

export const emergencyLine = (months: number): string => `Emergency fund: ${months} months of Essentials`;

/** "Japan trip: 5% a year return, 3% inflation" (inflation only where the goal uses it). */
export function goalAssumptionText(g: { name: string; return_bp: number; inflation_bp: number | null }): string {
  const infl = g.inflation_bp != null ? `${bpToPercent(g.inflation_bp)}% inflation` : "no inflation adjustment";
  return `${g.name}: ${bpToPercent(g.return_bp)}% a year return, ${infl}`;
}

// ---------------------------------------------------------------- fixed-cost overrides

/**
 * New `overrides` map for PUT /plan/settings: start from the stored overrides, apply edited line amounts (only when they
 * differ from what the line shows now), drop reset lines (back to baseline, or a line you added disappears) and add new lines.
 */
export function applyOverrideEdits(
  current: Record<string, number>,
  lines: Pick<FixedLine, "key" | "amount">[],
  edits: Record<string, number | null>,
  resets: ReadonlySet<string>,
  added: { key: string; amount: number | null }[],
): Record<string, number> {
  const out: Record<string, number> = { ...current };
  for (const l of lines) {
    if (resets.has(l.key)) { delete out[l.key]; continue; }
    const v = edits[l.key];
    if (v != null && v >= 0 && v !== l.amount) out[l.key] = v;
  }
  for (const a of added) {
    const key = a.key.trim().slice(0, 64);
    if (key && a.amount != null && a.amount >= 0) out[key] = a.amount;
  }
  return out;
}

// ---------------------------------------------------------------- wizard

export const WIZARD_FLAG = "okanary.planWizardDone";
export const WIZARD_STEPS = 5;
export type WizardStep = 1 | 2 | 3 | 4 | 5;
export const WIZARD_TITLES: Record<WizardStep, string> = {
  1: "Your take-home", 2: "Fixed costs", 3: "Your goals", 4: "Your plan", 5: "Use it",
};

/** localStorage is a per-device convenience: every access is wrapped, and a blocked store reads as "not done". */
export function readWizardDone(storage?: Pick<Storage, "getItem">): boolean {
  try { return (storage ?? localStorage).getItem(WIZARD_FLAG) === "1"; } catch { return false; }
}
export function writeWizardDone(storage?: Pick<Storage, "setItem">): void {
  try { (storage ?? localStorage).setItem(WIZARD_FLAG, "1"); } catch { /* blocked storage: the wizard may show again, which is harmless */ }
}

/** The wizard shows with no base income yet, or on the first open when no plan was ever accepted and it wasn't finished or skipped. */
export function wizardShows(i: { needsIncome: boolean; hasAcceptedPlan: boolean; flagDone: boolean }): boolean {
  return i.needsIncome || (!i.hasAcceptedPlan && !i.flagDone);
}

/** Start at the take-home step until an income exists, then at the fixed costs. */
export const wizardStartStep = (i: { needsIncome: boolean }): WizardStep => (i.needsIncome ? 1 : 2);
export const nextStep = (s: WizardStep): WizardStep => Math.min(WIZARD_STEPS, s + 1) as WizardStep;
export const prevStep = (s: WizardStep): WizardStep => Math.max(1, s - 1) as WizardStep;
/** "Next" needs a take-home figure on step 1; every other step can move on. */
export const canAdvance = (step: WizardStep, i: { incomeSet: boolean }): boolean => step !== 1 || i.incomeSet;
