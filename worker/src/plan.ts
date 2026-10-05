import {
  DEFAULT_CAP_PCT, DEFAULT_FLOOR_PCT, DEFAULT_SPLIT, REFERENCE_SPLITS, addMonths, buildPlan, formatMoneyShort, goalTarget, horizonFor, isSpend, monthRangeUtc, monthlyAverage, planVsActual,
  sgtDate, sgtMonth, signedSgdMinor,
  type PlanGoal, type PlanInput, type PlanOutput, type SplitGoal, type SplitRule, type UsualRow,
} from "@okanary/core";
import { loadBudgetRows, loadRowsBetween, upsertBudget } from "./db";
import { lifestyleBudgetFor } from "./allowance";
import { loadGoals, type GoalRow } from "./goals";
import { getSetting } from "./settings";
import { loadSubscriptionFixedCosts } from "./subscriptions";
import { ulid } from "./util";

/**
 * Plan and income (v2 P), worker side: loads rows (base income, subscriptions, Essentials/Lifestyle baselines, goals,
 * commission history), calls the pure engine in packages/core/src/plan.ts and does the I/O. Integer SGD minor units, SGT months.
 */

export const monthRe = /^\d{4}-(0[1-9]|1[0-2])$/;
export const DISCLAIMER = "Estimates, not financial advice.";
export const EMERGENCY_MONTHS_ASSUMED = 6;

// ---------------------------------------------------------------- income + split rule

export interface IncomeSettingRow { id: string; base_takehome_minor: number; currency: string; effective_from: string }
export interface IncomeEventRow { id: string; kind: "commission" | "bonus" | "other"; amount_minor: number; received_on: string; transaction_id: string | null; split_json: string | null; split_status: "proposed" | "confirmed" | "skipped" }

/** The income_settings row in force for `month` (latest effective_from <= month), or null. */
export async function baseIncomeFor(db: D1Database, month: string): Promise<IncomeSettingRow | null> {
  return db.prepare("SELECT * FROM income_settings WHERE effective_from <= ? ORDER BY effective_from DESC LIMIT 1").bind(month).first<IncomeSettingRow>();
}

export const validSplitRule = (r: SplitRule): boolean =>
  [r.goals_bp, r.fun_bp, r.buffer_bp].every((n) => Number.isInteger(n) && n >= 0 && n <= 10000) && r.goals_bp + r.fun_bp + r.buffer_bp === 10000;

/** Setting 'commission_split' ({goals_bp, fun_bp, buffer_bp}); anything missing or invalid falls back to the default 70/20/10. */
export async function loadSplitRule(db: D1Database): Promise<SplitRule> {
  const raw = await getSetting(db, "commission_split");
  if (!raw) return DEFAULT_SPLIT;
  try {
    const r = JSON.parse(raw) as SplitRule;
    const rule = { goals_bp: r.goals_bp, fun_bp: r.fun_bp, buffer_bp: r.buffer_bp };
    return validSplitRule(rule) ? rule : DEFAULT_SPLIT;
  } catch { return DEFAULT_SPLIT; }
}

/** Goals as the split needs them: gap = max(0, target − value − pledged). */
export async function loadSplitGoals(db: D1Database, now: Date): Promise<SplitGoal[]> {
  return (await loadGoals(db, now)).goals.map((g) => ({ id: g.id, priority: g.priority, state: g.status.state, kind: g.kind, gap: Math.max(0, g.target - g.value - g.totals.pledged) }));
}

// ---------------------------------------------------------------- plan settings

export interface PlanSettings { overrides: Record<string, number>; lifestyle_floor_minor: number | null }

export async function loadPlanSettings(db: D1Database): Promise<PlanSettings> {
  const [ov, fl] = await Promise.all([getSetting(db, "plan_overrides"), getSetting(db, "plan_lifestyle_floor_minor")]);
  let overrides: Record<string, number> = {};
  try {
    const parsed = ov ? (JSON.parse(ov) as Record<string, unknown>) : {};
    overrides = Object.fromEntries(Object.entries(parsed).filter(([, v]) => Number.isSafeInteger(v) && (v as number) >= 0)) as Record<string, number>;
  } catch { /* ignore a corrupt value */ }
  const n = Number(fl);
  return { overrides, lifestyle_floor_minor: fl != null && fl !== "" && Number.isSafeInteger(n) && n >= 0 ? n : null };
}

// ---------------------------------------------------------------- inputs

/** Monthly commission totals (kind 'commission') for the complete months since the first commission month, most recent first, at most 6. Empty without commission. */
export async function commissionHistory(db: D1Database, now: Date): Promise<number[]> {
  const rows = (await db.prepare("SELECT received_on, amount_minor FROM income_events WHERE kind = 'commission' ORDER BY received_on").all<{ received_on: string; amount_minor: number }>()).results;
  if (rows.length === 0) return [];
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(r.received_on.slice(0, 7), (totals.get(r.received_on.slice(0, 7)) ?? 0) + r.amount_minor);
  const last = addMonths(sgtMonth(now), -1);
  const out: number[] = [];
  for (let m = last, first = rows[0]!.received_on.slice(0, 7); m >= first && out.length < 6; m = addMonths(m, -1)) out.push(totals.get(m) ?? 0);
  return out;
}

type BaselineRow = UsualRow & { recurring_id?: string | null };

/**
 * Everything buildPlan needs for `month`, or null when no base income is set (the caller answers needs_income).
 * Essentials = per category, last 3 complete months with data, subscription-linked charges excluded (they are in the
 * subscription part of fixed costs); Lifestyle average includes everything Lifestyle.
 */
export async function planInputs(db: D1Database, now: Date, month: string): Promise<PlanInput | null> {
  const base = await baseIncomeFor(db, month);
  if (!base) return null;
  const cur = sgtMonth(now);
  const rows = (await loadRowsBetween(db, addMonths(cur, -12), addMonths(cur, -1))) as unknown as BaselineRow[];
  const cats = (await db.prepare("SELECT id, name FROM categories WHERE group_id = 'essentials' ORDER BY sort, id").all<{ id: string; name: string }>()).results;
  const essentials: PlanInput["essentials"] = [];
  for (const c of cats) {
    const { average } = monthlyAverage(rows, now, (r) => r.group_id === "essentials" && r.category_id === c.id && !(r as BaselineRow).recurring_id, { maxMonths: 3 });
    if (average != null && average > 0) essentials.push({ key: c.id, label: c.name, amount: average });
  }
  const lifestyleAverage = monthlyAverage(rows, now, (r) => r.group_id === "lifestyle", { maxMonths: 3 }).average;
  const settings = await loadPlanSettings(db);
  const { fixed } = await loadSubscriptionFixedCosts(db);
  const goalViews = (await loadGoals(db, now)).goals;
  const goals: PlanGoal[] = goalViews.map((g) => ({
    id: g.id, name: g.name, priority: g.priority, kind: g.kind, target_today_minor: g.target_today_minor, inflation_bp: g.inflation_bp,
    return_bp: g.return_bp, target_date: g.target_date, value: g.value, state: g.status.state,
  }));
  return {
    month, today: sgtDate(now), income: base.base_takehome_minor,
    subscriptions: { monthly: fixed.monthly, setAside: fixed.setAside },
    essentials, overrides: settings.overrides, lifestyleAverage, floorOverride: settings.lifestyle_floor_minor,
    goals, commissionHistory: await commissionHistory(db, now), commissionGoalsBp: (await loadSplitRule(db)).goals_bp,
  };
}

// ---------------------------------------------------------------- the GET payload

export interface AcceptedPlan { id: string; month: string; inputs: PlanInput; outputs: PlanOutput; accepted: true; accepted_at: string | null }

interface PlanRow { id: string; month: string; inputs_json: string; outputs_json: string; accepted: number; accepted_at: string | null }

export async function acceptedPlanFor(db: D1Database, month: string): Promise<AcceptedPlan | null> {
  const r = await db.prepare("SELECT * FROM plans WHERE month = ? AND accepted = 1 ORDER BY accepted_at DESC, id DESC LIMIT 1").bind(month).first<PlanRow>();
  return r ? { id: r.id, month: r.month, inputs: JSON.parse(r.inputs_json), outputs: JSON.parse(r.outputs_json), accepted: true, accepted_at: r.accepted_at } : null;
}

export async function planPayload(db: D1Database, now: Date, month: string) {
  const inputs = await planInputs(db, now, month);
  if (!inputs) return { month, needs_income: true as const };
  const plan = buildPlan(inputs);
  const accepted = await acceptedPlanFor(db, month);
  const lifestyleBudget = lifestyleBudgetFor(await loadBudgetRows(db), month);
  const budget_source = lifestyleBudget == null ? "none" : accepted && accepted.outputs.lifestyle === lifestyleBudget ? "plan" : "manual";
  return {
    month, plan, inputs, accepted, lifestyle_budget: lifestyleBudget, budget_source,
    assumptions: {
      floor_pct: DEFAULT_FLOOR_PCT, cap_pct: DEFAULT_CAP_PCT, emergency_months: EMERGENCY_MONTHS_ASSUMED,
      goals: inputs.goals.map((g) => ({ id: g.id, name: g.name, return_bp: g.return_bp, inflation_bp: g.inflation_bp })),
    },
    references: REFERENCE_SPLITS,
    disclaimer: DISCLAIMER,
  };
}

// ---------------------------------------------------------------- accepting

/**
 * Accept the plan for `month`: optionally push the lowest-priority goals' dates out first (the 'extend' trade-off, same
 * columns a goal PATCH refreshes), store the plan, write the month's Lifestyle budget (→ A's weekly allowance) and set each
 * goal's planned monthly. Returns false when there is no base income to plan from.
 */
export async function acceptPlan(db: D1Database, now: Date, month: string, extend: boolean): Promise<boolean> {
  let inputs = await planInputs(db, now, month);
  if (!inputs) return false;
  let plan = buildPlan(inputs);
  const today = sgtDate(now);
  const ext = extend ? plan.tradeOffs.find((t) => t.kind === "extend") : undefined;
  if (ext && ext.kind === "extend" && ext.changes.length) {
    for (const ch of ext.changes) {
      const g = await db.prepare("SELECT * FROM goals WHERE id = ?").bind(ch.id).first<GoalRow>();
      if (!g) continue;
      await db.prepare("UPDATE goals SET target_date = ?, horizon = ?, target_sgd_minor = ? WHERE id = ?")
        .bind(ch.to, horizonFor(ch.to, today, g.kind), goalTarget({ kind: g.kind, target_today_minor: g.target_today_minor, inflation_bp: g.inflation_bp, target_date: ch.to }, today), g.id).run();
    }
    inputs = (await planInputs(db, now, month))!;
    plan = buildPlan(inputs);
  }
  const at = now.toISOString();
  await db.prepare("UPDATE plans SET accepted = 0 WHERE month = ? AND accepted = 1").bind(month).run();
  await db.prepare("INSERT INTO plans (id, month, inputs_json, outputs_json, accepted, accepted_at) VALUES (?,?,?,?,1,?)")
    .bind(ulid(now.getTime()), month, JSON.stringify(inputs), JSON.stringify(plan), at).run();
  await upsertBudget(db, "group", "lifestyle", month, plan.lifestyle);
  await db.batch([
    db.prepare("UPDATE goals SET planned_monthly_minor = NULL"),
    ...plan.goals.allocations.map((a) => db.prepare("UPDATE goals SET planned_monthly_minor = ? WHERE id = ?").bind(a.total, a.id)),
  ]);
  return true;
}

// ---------------------------------------------------------------- monthly check-in

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortMonth = (month: string) => SHORT_MONTHS[Number(month.slice(5)) - 1]!;

/** Actuals for a month, in the plan's terms: fixed = Essentials spend + spend linked to subscriptions in other groups; lifestyle = Lifestyle minus its subscription-linked part; goals = transferred contributions. */
export async function planActuals(db: D1Database, month: string): Promise<{ fixed: number; goals: number; lifestyle: number }> {
  const rows = (await loadRowsBetween(db, month, month)) as unknown as BaselineRow[];
  let fixed = 0, lifestyle = 0;
  for (const r of rows) {
    if (!isSpend(r)) continue;
    const a = signedSgdMinor(r);
    if (r.group_id === "essentials") fixed += a;
    else if (r.recurring_id) fixed += a;
    else if (r.group_id === "lifestyle") lifestyle += a;
  }
  const range = monthRangeUtc(month);
  const g = await db.prepare("SELECT COALESCE(SUM(amount_sgd_minor), 0) AS n FROM goal_contributions WHERE status = 'transferred' AND COALESCE(resolved_at, created_at) >= ?1 AND COALESCE(resolved_at, created_at) < ?2")
    .bind(range.start, range.end).first<{ n: number }>();
  return { fixed, goals: g?.n ?? 0, lifestyle };
}

/**
 * Lines for the 1st-of-month summary: last month's plan vs actual (when a plan was accepted for it), the new month's plan
 * Lifestyle figure (when computable) and the number of commission splits waiting for a decision. Neutral wording.
 */
export async function planSummaryLines(db: D1Database, now: Date): Promise<string[]> {
  const cur = sgtMonth(now);
  const ended = addMonths(cur, -1);
  const lines: string[] = [];
  const accepted = await acceptedPlanFor(db, ended);
  if (accepted) {
    const o = accepted.outputs;
    const actual = await planActuals(db, ended);
    const cmp = planVsActual({ fixed: o.fixed.total, goals: o.goals.total, lifestyle: o.lifestyle }, actual);
    const part = (k: "fixed" | "goals" | "lifestyle") => { const c = cmp.find((x) => x.key === k)!; return `${k} ${formatMoneyShort(c.actual)} (plan ${formatMoneyShort(c.planned)})`; };
    lines.push(`Plan vs actual (${shortMonth(ended)}): ${part("fixed")} · ${part("goals")} · ${part("lifestyle")}`);
  }
  const inputs = await planInputs(db, now, cur);
  if (inputs) lines.push(`New plan for ${shortMonth(cur)}: lifestyle ${formatMoneyShort(buildPlan(inputs).lifestyle)}`);
  const pending = (await db.prepare("SELECT COUNT(*) AS n FROM income_events WHERE split_status = 'proposed'").first<{ n: number }>())?.n ?? 0;
  if (pending > 0) lines.push(`${pending} commission split${pending === 1 ? "" : "s"} to confirm`);
  return lines;
}
