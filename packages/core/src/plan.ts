import { daysInMonth } from "./dates";
import { goalTarget, monthsBetween, requiredMonthly, type GoalKind, type GoalState } from "./goals";

/**
 * Plan engine (v2 feature P). Deterministic: from base take-home income I,
 *   C_fixed = subscriptions (monthly equivalent) + annual set-asides + Essentials baseline lines (overridable)
 *   C_goals = Σ PMT_req over goals in priority order
 *   L = I − C_fixed − C_goals
 * Feasible when L ≥ floor (default 60% of the last-3-month Lifestyle average). Lifestyle budget = min(L, average + 10%);
 * the excess goes to goals in priority order. Infeasible → computed trade-offs. Integer SGD minor units throughout.
 */

export interface PlanGoal {
  id: string;
  name: string;
  priority: number;
  kind: GoalKind;
  target_today_minor: number;
  inflation_bp: number | null;
  return_bp: number;
  target_date: string | null;
  /** current value (G) */
  value: number;
  state: GoalState;
}

export interface FixedLine { key: string; label: string; amount: number; overridden: boolean }

export interface PlanInput {
  month: string; // 'YYYY-MM' the plan is for
  today: string; // SGT 'YYYY-MM-DD'
  income: number; // base take-home
  subscriptions: { monthly: number; setAside: number };
  /** Essentials baseline per category (average of the last 3 months, subscriptions excluded), e.g. { rent: 180000, groceries: 60000 } */
  essentials: { key: string; label: string; amount: number }[];
  /** David's per-line overrides (by key), e.g. { rent: 200000 }; new keys add a line */
  overrides?: Record<string, number>;
  lifestyleAverage: number | null;
  /** explicit floor (setting); default 60% of lifestyleAverage, 0 without history (C14) */
  floorOverride?: number | null;
  floorPct?: number;
  capPct?: number;
  goals: PlanGoal[];
  /** monthly commission totals, most recent first (only used when ≥ 3 months exist) */
  commissionHistory?: number[];
  /** share of commission that goes to goals in the split rule (bp) */
  commissionGoalsBp?: number;
}

export interface GoalAllocation { id: string; name: string; priority: number; required: number; extra: number; total: number }

export interface TradeOffExtend { kind: "extend"; changes: { id: string; name: string; from: string | null; to: string; required: number }[]; covers: boolean }
export interface TradeOffLower { kind: "lower_lifestyle"; lifestyle: number; weekly: number }
export interface TradeOffCommission { kind: "commission"; shortfall: number; commissionNeeded: number; averageCommission: number; covered: boolean }
export type TradeOff = TradeOffExtend | TradeOffLower | TradeOffCommission;

export interface PlanOutput {
  income: number;
  fixed: { lines: FixedLine[]; total: number };
  goals: { allocations: GoalAllocation[]; required: number; total: number };
  /** I − C_fixed − C_goals (before the cap) */
  available: number;
  floor: number;
  cap: number | null;
  feasible: boolean;
  /** the monthly Lifestyle budget the plan prescribes (feasible: min(L, cap); infeasible: max(L, 0)) */
  lifestyle: number;
  /** above the cap with no goal left to absorb it */
  unallocated: number;
  shortfall: number;
  tradeOffs: TradeOff[];
  /** needs / savings / wants percentages (sum 100) */
  split: { needs: number; savings: number; wants: number };
  splitText: string;
  references: { name: string; needs: number; savings: number; wants: number }[];
}

export const DEFAULT_FLOOR_PCT = 60;
export const MAX_EXTENSION_MONTHS = 120;
export const DEFAULT_CAP_PCT = 10;
export const REFERENCE_SPLITS = [
  { name: "50/30/20", needs: 50, savings: 20, wants: 30 },
  { name: "60/20/20 (Singapore)", needs: 60, savings: 20, wants: 20 },
];

/** Integer percentages of parts that sum to exactly 100 (largest remainder). All zero → zeros. */
export function percentages(parts: number[]): number[] {
  const pos = parts.map((p) => Math.max(0, p));
  const total = pos.reduce((a, b) => a + b, 0);
  if (total === 0) return parts.map(() => 0);
  const exact = pos.map((p) => (p * 100) / total);
  const out = exact.map(Math.floor);
  let left = 100 - out.reduce((a, b) => a + b, 0);
  const order = exact.map((e, i) => ({ i, r: e - Math.floor(e) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (const o of order) { if (left <= 0) break; out[o.i]!++; left--; }
  return out;
}

const goalMonthsLeft = (g: PlanGoal, today: string) => (g.target_date ? monthsBetween(today, g.target_date) : 12);
const goalTargetNow = (g: PlanGoal, today: string, date = g.target_date) => goalTarget({ kind: g.kind, target_today_minor: g.target_today_minor, inflation_bp: g.inflation_bp, target_date: date }, today);
export const goalRequired = (g: PlanGoal, today: string): number => requiredMonthly(goalTargetNow(g, today), g.value, g.return_bp, goalMonthsLeft(g, today));

const addMonthsToDate = (date: string, n: number) => {
  const y = +date.slice(0, 4), m = +date.slice(5, 7), d = +date.slice(8, 10);
  const idx = y * 12 + (m - 1) + n;
  const ny = Math.floor(idx / 12), nm = (idx % 12) + 1;
  const dim = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(d, dim)).padStart(2, "0")}`;
};

/** Weekly allowance a monthly Lifestyle amount implies for a 7-day week of `month`. */
export const weeklyFromMonthly = (monthly: number, month: string): number => Math.round((Math.max(0, monthly) * 7) / daysInMonth(month));

export function buildPlan(i: PlanInput): PlanOutput {
  const overrides = i.overrides ?? {};
  const lines: FixedLine[] = [
    { key: "subscriptions", label: "Subscriptions", amount: i.subscriptions.monthly, overridden: false },
    { key: "set_aside", label: "Annual renewals (set aside)", amount: i.subscriptions.setAside, overridden: false },
    ...i.essentials.map((e) => ({ key: e.key, label: e.label, amount: e.amount, overridden: false })),
  ];
  for (const [k, v] of Object.entries(overrides)) {
    const l = lines.find((x) => x.key === k);
    if (l) { l.amount = v; l.overridden = true; } else lines.push({ key: k, label: k, amount: v, overridden: true });
  }
  const fixed = lines.reduce((a, l) => a + l.amount, 0);

  const goals = [...i.goals].sort((a, b) => a.priority - b.priority);
  const allocations: GoalAllocation[] = goals.map((g) => {
    const required = goalRequired(g, i.today);
    return { id: g.id, name: g.name, priority: g.priority, required, extra: 0, total: required };
  });
  const goalsRequired = allocations.reduce((a, g) => a + g.required, 0);
  const available = i.income - fixed - goalsRequired;
  const avg = i.lifestyleAverage;
  const floor = i.floorOverride != null ? i.floorOverride : avg != null && avg > 0 ? Math.round((avg * (i.floorPct ?? DEFAULT_FLOOR_PCT)) / 100) : 0;
  const cap = avg != null && avg > 0 ? Math.round((avg * (100 + (i.capPct ?? DEFAULT_CAP_PCT))) / 100) : null;
  const feasible = available >= floor;

  let lifestyle: number;
  let unallocated = 0;
  const tradeOffs: TradeOff[] = [];
  let shortfall = 0;
  if (feasible) {
    lifestyle = cap != null ? Math.min(available, cap) : available;
    let overflow = available - lifestyle;
    // overflow → goals in priority order, each up to what it still needs after this month's required amount
    for (const a of allocations) {
      if (overflow <= 0) break;
      const g = goals.find((x) => x.id === a.id)!;
      const room = Math.max(0, goalTargetNow(g, i.today) - g.value - a.required);
      const add = Math.min(room, overflow);
      a.extra += add; a.total += add; overflow -= add;
    }
    unallocated = overflow;
  } else {
    shortfall = floor - available;
    lifestyle = Math.max(available, 0);
    tradeOffs.push(extendTradeOff(goals, allocations, shortfall, i.today));
    tradeOffs.push({ kind: "lower_lifestyle", lifestyle: Math.max(available, 0), weekly: weeklyFromMonthly(available, i.month) });
    const hist = i.commissionHistory ?? [];
    if (hist.length >= 3) {
      const goalsShare = (i.commissionGoalsBp ?? 7000) / 10000;
      const averageCommission = Math.round(hist.slice(0, 6).reduce((a, b) => a + b, 0) / Math.min(hist.length, 6));
      const commissionNeeded = Math.ceil(shortfall / goalsShare);
      tradeOffs.push({ kind: "commission", shortfall, commissionNeeded, averageCommission, covered: averageCommission >= commissionNeeded });
    }
  }
  const goalsTotal = allocations.reduce((a, g) => a + g.total, 0);
  const [needs, savings, wants] = percentages([fixed, goalsTotal + unallocated, lifestyle]);
  return {
    income: i.income,
    fixed: { lines, total: fixed },
    goals: { allocations, required: goalsRequired, total: goalsTotal },
    available, floor, cap, feasible, lifestyle, unallocated, shortfall, tradeOffs,
    split: { needs: needs!, savings: savings!, wants: wants! },
    splitText: `Your plan: ${needs} / ${savings} / ${wants} (needs / savings / wants)`,
    references: REFERENCE_SPLITS,
  };
}

/** Push back the lowest-priority goals' dates (one month at a time, at most 10 years each) until the shortfall is covered. */
function extendTradeOff(goals: PlanGoal[], allocations: GoalAllocation[], shortfall: number, today: string): TradeOffExtend {
  const changes: TradeOffExtend["changes"] = [];
  let left = shortfall;
  for (const g of [...goals].sort((a, b) => b.priority - a.priority)) {
    if (left <= 0) break;
    const a = allocations.find((x) => x.id === g.id)!;
    if (a.required <= 0 || !g.target_date) continue;
    const need = Math.max(0, a.required - left); // what this goal may still require per month
    let to: string | null = null;
    let req = a.required;
    for (let k = 1; k <= MAX_EXTENSION_MONTHS; k++) {
      const d = addMonthsToDate(g.target_date, k);
      req = requiredMonthly(goalTargetNow(g, today, d), g.value, g.return_bp, monthsBetween(today, d));
      to = d;
      if (req <= need) break;
    }
    if (!to) continue;
    changes.push({ id: g.id, name: g.name, from: g.target_date, to, required: req });
    left -= a.required - req;
  }
  return { kind: "extend", changes, covers: left <= 0 };
}

// ---------- commission split ----------

export interface SplitRule { goals_bp: number; fun_bp: number; buffer_bp: number }
export const DEFAULT_SPLIT: SplitRule = { goals_bp: 7000, fun_bp: 2000, buffer_bp: 1000 };

export interface SplitGoal { id: string; priority: number; state: GoalState; kind: GoalKind; archived?: number; /** what it still needs to reach its target */ gap: number }

export interface CommissionSplit {
  goals: number;
  fun: number;
  buffer: number;
  pledges: { goal_id: string; amount: number; part: "goals" | "buffer" }[];
  /** guilt-free share: one-off addition to this week's Lifestyle allowance */
  bonus: number;
  unallocated: number;
}

/**
 * Commission split (default 70% goals / 20% guilt-free / 10% buffer). Goals part: behind goals first, then the rest, each in
 * priority order, up to its gap. Buffer: tops up the emergency fund while it has a gap, the rest joins the goals waterfall.
 */
export function commissionSplit(amount: number, rule: SplitRule, goals: SplitGoal[]): CommissionSplit {
  const goalsPart = Math.round((amount * rule.goals_bp) / 10000);
  const fun = Math.round((amount * rule.fun_bp) / 10000);
  const buffer = amount - goalsPart - fun;
  const live = goals.filter((g) => !g.archived);
  const gaps = new Map(live.map((g) => [g.id, Math.max(0, g.gap)]));
  const pledges: CommissionSplit["pledges"] = [];
  const add = (goal_id: string, amt: number, part: "goals" | "buffer") => {
    if (amt <= 0) return;
    const ex = pledges.find((p) => p.goal_id === goal_id && p.part === part);
    if (ex) ex.amount += amt; else pledges.push({ goal_id, amount: amt, part });
    gaps.set(goal_id, gaps.get(goal_id)! - amt);
  };
  const order = [...live].sort((a, b) => (a.state === "behind" ? 0 : 1) - (b.state === "behind" ? 0 : 1) || a.priority - b.priority);
  const pour = (amt: number, part: "goals" | "buffer") => {
    let left = amt;
    for (const g of order) {
      if (left <= 0) break;
      const take = Math.min(left, gaps.get(g.id)!);
      add(g.id, take, part);
      left -= take;
    }
    return left;
  };
  let unallocated = pour(goalsPart, "goals");
  let bufLeft = buffer;
  const ef = [...live].filter((g) => g.kind === "emergency").sort((a, b) => a.priority - b.priority)[0];
  if (ef && gaps.get(ef.id)! > 0) {
    const take = Math.min(bufLeft, gaps.get(ef.id)!);
    add(ef.id, take, "buffer");
    bufLeft -= take;
  }
  unallocated += pour(bufLeft, "buffer");
  return { goals: goalsPart, fun, buffer, pledges, bonus: fun, unallocated };
}

// ---------- monthly check-in ----------

export interface PlanActual { fixed: number; goals: number; lifestyle: number }
/** Last month's plan vs actual (positive diff = more than planned). */
export function planVsActual(plan: { fixed: number; goals: number; lifestyle: number }, actual: PlanActual) {
  return (["fixed", "goals", "lifestyle"] as const).map((k) => ({ key: k, planned: plan[k], actual: actual[k], diff: actual[k] - plan[k] }));
}
