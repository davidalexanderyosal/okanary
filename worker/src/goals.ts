import {
  DEFAULT_RETURN_BP, buildSnapshot, contributionTotals, dayOfWeek, formatMoneyShort, fundingWarnings, goalPace, goalStatus, goalTarget, goalValue, goalsSummaryLine,
  horizonFor, linkedMarket, marketByItem, paceWindowStart, projectionRange, saferFundingPrompt, sgtDate, sgtParts, sgtWeek, shiftWeek, underspendAmount, underspendGoal, weekOf,
  type FundingLink, type FundingWarning, type GoalKind, type GoalStatus, type Horizon, type SnapshotValues, type ValueLookup,
} from "@okanary/core";
import { loadAllowanceSettings, loadWeekAllowance } from "./allowance";
import type { Deps } from "./deps";
import type { Env } from "./env";
import { cachedFx, loadCardLiabilities, loadSnapshotInputs, neededCurrencies, snapshotFromRow } from "./networth-job";
import { sendNudge } from "./nudge-gate";
import { ulid } from "./util";

/**
 * Goals (v2 G), worker side: loads rows and calls the pure maths in packages/core/src/goals.ts. Values come from the
 * net worth snapshot (linked accounts / holdings), earmarks and transferred contributions only (one source of truth).
 */

export interface GoalRow {
  id: string; name: string; emoji: string | null; target_sgd_minor: number; target_date: string | null; receives_underspend: number; archived: number;
  created_at: string; horizon: Horizon | null; priority: number; target_today_minor: number; inflation_bp: number | null; return_bp: number | null;
  kind: GoalKind; start_date: string | null; planned_monthly_minor: number | null;
}
export interface FundingRow extends FundingLink { id: string }
export interface ContributionRow {
  id: string; goal_id: string; period: string; amount_sgd_minor: number; source: "underspend" | "want_skipped" | "commission" | "manual";
  status: "pledged" | "transferred" | "skipped"; created_at: string; resolved_at: string | null;
}
export type WarningWithGoals = FundingWarning & { goal_ids: string[] };

export const SAFER_FUNDING_KIND = "goal_safer_funding";

// ---------------------------------------------------------------- values from the net worth snapshot

export type GoalValues = ValueLookup & { holdingAccount: (holdingId: string) => string | null };

/** account(id) = balance + its holdings (SGD); holding(id) = value; holdingAccount(id) = the account that holds it. */
export function valueLookup(snapshot: SnapshotValues): GoalValues {
  const accounts = new Map(snapshot.breakdown.accounts.map((a) => [a.id, a.balance_sgd + a.holdings_sgd]));
  const holdings = new Map(snapshot.breakdown.holdings.map((h) => [h.id, h]));
  return {
    account: (id) => accounts.get(id) ?? null,
    holding: (id) => holdings.get(id)?.value_sgd ?? null,
    holdingAccount: (id) => holdings.get(id)?.account_id ?? null,
  };
}

/** The latest stored snapshot; with none yet, a live one from cached quotes/FX (never fetches), like GET /api/networth. */
export async function currentSnapshot(db: D1Database, now: Date): Promise<SnapshotValues> {
  const row = await db.prepare("SELECT * FROM networth_snapshots ORDER BY date DESC LIMIT 1").first<Parameters<typeof snapshotFromRow>[0]>();
  if (row) return snapshotFromRow(row);
  const today = sgtDate(now);
  const inputs = await loadSnapshotInputs(db, today);
  const fx = await cachedFx(db, neededCurrencies(inputs, today));
  const cards = await loadCardLiabilities(db, now);
  return buildSnapshot({ date: today, ...inputs, cards, fx });
}

/** Risky = a holding link, or a link to a brokerage/crypto account. */
export function hasRiskyFunding(links: FundingLink[], accountKind: (id: string) => string | undefined): boolean {
  return links.some((l) => l.source_type === "holding" || (l.source_type === "nw_account" && ["brokerage", "crypto"].includes(accountKind(l.source_id) ?? "")));
}

async function accountKinds(db: D1Database): Promise<Map<string, string>> {
  return new Map((await db.prepare("SELECT id, kind FROM nw_accounts").all<{ id: string; kind: string }>()).results.map((r) => [r.id, r.kind]));
}

const warningConcerns = (w: FundingWarning, links: FundingLink[]) =>
  links.some((l) => (w.type === "share_over" ? l.source_type === w.source_type && l.source_id === w.source_id : l.source_type !== "holding" && l.source_id === w.account_id));

/** Funding warnings across ALL non-archived goals' links, each tagged with the goals it concerns. */
export function warningsFor(links: FundingRow[], values: ValueLookup): WarningWithGoals[] {
  return fundingWarnings(links, values).map((w) => ({ ...w, goal_ids: [...new Set(links.filter((l) => warningConcerns(w, [l])).map((l) => l.goal_id))] }));
}

export async function loadLiveFunding(db: D1Database): Promise<FundingRow[]> {
  return (await db.prepare("SELECT f.* FROM goal_funding f JOIN goals g ON g.id = f.goal_id WHERE g.archived = 0 ORDER BY f.rowid").all<FundingRow>()).results;
}

/** Warnings across all goals, from the current values (used by the funding routes). */
export async function loadFundingWarnings(db: D1Database, now: Date): Promise<WarningWithGoals[]> {
  return warningsFor(await loadLiveFunding(db), valueLookup(await currentSnapshot(db, now)));
}

// ---------------------------------------------------------------- the goal view

export interface GoalView {
  id: string; name: string; emoji: string | null; kind: GoalKind; priority: number;
  target_date: string | null; start_date: string | null; created_at: string;
  target_today_minor: number; inflation_bp: number | null;
  horizon: Horizon; return_bp: number; return_bp_is_default: boolean;
  /** target at the target date (inflated for mid/long) */
  target: number;
  /** progress: linked values + earmarks (+ transferred contributions for goals without share links) */
  value: number;
  value_parts: { linked: number; earmarked: number; contributions: number; counts_contributions: boolean };
  /** net monthly saving over the last 3 months, market moves excluded; null until there is an earlier snapshot */
  pace: number | null;
  status: GoalStatus;
  /** long goals: projected value at the target date at return −2 / base / +2 pp */
  range: { conservative: number; base: number; optimistic: number } | null;
  /** progress counts transferred only; pledged is shown apart */
  totals: { transferred: number; pledged: number; skipped: number };
  pledges: ContributionRow[];
  funding: FundingRow[];
  warnings: WarningWithGoals[];
  planned_monthly_minor: number | null;
  receives_underspend: boolean;
  safer_funding_suggested: boolean;
}

export interface GoalsResult {
  today: string;
  goals: GoalView[];
  summary: string | null;
  receiving_goal_id: string | null;
  warnings: WarningWithGoals[];
}

const groupBy = <T, K>(rows: T[], key: (r: T) => K): Map<K, T[]> => {
  const m = new Map<K, T[]>();
  for (const r of rows) { const k = key(r); const a = m.get(k); if (a) a.push(r); else m.set(k, [r]); }
  return m;
};

/** Per-day market movement (marketByItem) for every consecutive pair of stored snapshots, starting from the one at/before `from`. */
async function marketPairs(db: D1Database, from: string, today: string): Promise<{ date: string; map: Map<string, number> }[]> {
  const rows = (await db.prepare("SELECT * FROM networth_snapshots WHERE date >= COALESCE((SELECT MAX(date) FROM networth_snapshots WHERE date <= ?1), ?1) AND date <= ?2 ORDER BY date").bind(from, today).all<Parameters<typeof snapshotFromRow>[0]>()).results;
  const snaps = rows.map(snapshotFromRow);
  return snaps.slice(1).map((cur, i) => ({ date: cur.date, map: marketByItem(snaps[i]!, cur) }));
}

export async function loadGoals(db: D1Database, now: Date): Promise<GoalsResult> {
  const today = sgtDate(now);
  const rows = (await db.prepare("SELECT * FROM goals WHERE archived = 0 ORDER BY priority, created_at, id").all<GoalRow>()).results;
  if (rows.length === 0) return { today, goals: [], summary: null, receiving_goal_id: null, warnings: [] };

  const values = valueLookup(await currentSnapshot(db, now));
  const kinds = await accountKinds(db);
  const links = await loadLiveFunding(db);
  const linksBy = groupBy(links, (l) => l.goal_id);
  const contribs = groupBy((await db.prepare("SELECT * FROM goal_contributions ORDER BY created_at, id").all<ContributionRow>()).results, (c) => c.goal_id);
  const snapsBy = groupBy(
    (await db.prepare("SELECT goal_id, date, value_sgd_minor FROM goal_snapshots WHERE date < ? ORDER BY date").bind(today).all<{ goal_id: string; date: string; value_sgd_minor: number }>()).results,
    (s) => s.goal_id,
  );
  const alerted = new Set((await db.prepare("SELECT ref FROM alert_log WHERE kind = ?").bind(SAFER_FUNDING_KIND).all<{ ref: string }>()).results.map((r) => r.ref));
  const allWarnings = warningsFor(links, values);

  // baseline per goal: latest snapshot on/before today − 3 months, else the earliest one (before today)
  const windowStart = paceWindowStart(today);
  const baselines = new Map<string, { date: string; value: number }>();
  for (const g of rows) {
    const list = snapsBy.get(g.id) ?? [];
    const onOrBefore = [...list].reverse().find((s) => s.date <= windowStart) ?? list[0];
    if (onOrBefore) baselines.set(g.id, { date: onOrBefore.date, value: onOrBefore.value_sgd_minor });
  }
  const earliest = [...baselines.values()].map((b) => b.date).sort()[0];
  const pairs = earliest ? await marketPairs(db, earliest, today) : [];

  const goals: GoalView[] = rows.map((g) => {
    const gl = linksBy.get(g.id) ?? [];
    const all = contribs.get(g.id) ?? [];
    const totals = contributionTotals(all);
    const target = goalTarget(g, today);
    const horizon = horizonFor(g.target_date, today, g.kind);
    const returnBp = g.return_bp ?? DEFAULT_RETURN_BP[horizon];
    const gv = goalValue(gl, values, totals.transferred);
    const baseline = baselines.get(g.id) ?? null;
    const market = baseline ? linkedMarket(gl, pairs.filter((p) => p.date > baseline.date && p.date <= today).map((p) => p.map), values.holdingAccount) : 0;
    const pace = goalPace({ valueNow: gv.value, baseline, marketSinceBaseline: market, today });
    const status = goalStatus({ target, value: gv.value, pace: pace ?? 0, returnBp, targetDate: g.target_date, today });
    return {
      id: g.id, name: g.name, emoji: g.emoji, kind: g.kind, priority: g.priority, target_date: g.target_date, start_date: g.start_date, created_at: g.created_at,
      target_today_minor: g.target_today_minor, inflation_bp: g.inflation_bp,
      horizon, return_bp: returnBp, return_bp_is_default: g.return_bp == null,
      target, value: gv.value,
      value_parts: { linked: gv.linked, earmarked: gv.earmarked, contributions: gv.contributions, counts_contributions: gv.countsContributions },
      pace, status,
      range: horizon === "long" ? projectionRange(gv.value, pace ?? 0, returnBp, status.monthsLeft) : null,
      totals,
      pledges: all.filter((c) => c.status === "pledged").reverse(),
      funding: gl,
      warnings: allWarnings.filter((w) => w.goal_ids.includes(g.id)),
      planned_monthly_minor: g.planned_monthly_minor,
      receives_underspend: !!g.receives_underspend,
      safer_funding_suggested: alerted.has(g.id) && horizon === "short" && hasRiskyFunding(gl, (id) => kinds.get(id)),
    };
  });

  const receiving = underspendGoal(goals.map((g) => ({ id: g.id, priority: g.priority, archived: 0, receives_underspend: g.receives_underspend ? 1 : 0, state: g.status.state })));
  return { today, goals, summary: goalsSummaryLine(goals), receiving_goal_id: receiving?.id ?? null, warnings: allWarnings };
}

// ---------------------------------------------------------------- daily snapshots (afterSnapshot hook of the net worth job)

/**
 * From the day's net worth snapshot: write goal_snapshots (value from THAT breakdown + transferred contributions), refresh
 * each goal's horizon and target, and, once, suggest safer funding when a goal with stock/crypto funding drops below 2 years.
 */
export async function snapshotGoals(env: Env, deps: Deps, snapshot: SnapshotValues): Promise<void> {
  const db = env.DB;
  const today = snapshot.date;
  const goals = (await db.prepare("SELECT * FROM goals WHERE archived = 0 ORDER BY priority, id").all<GoalRow>()).results;
  if (goals.length === 0) return;
  const values = valueLookup(snapshot);
  const kinds = await accountKinds(db);
  const linksBy = groupBy(await loadLiveFunding(db), (l) => l.goal_id);
  const transferred = new Map((await db.prepare("SELECT goal_id, SUM(amount_sgd_minor) AS n FROM goal_contributions WHERE status = 'transferred' GROUP BY goal_id").all<{ goal_id: string; n: number }>()).results.map((r) => [r.goal_id, r.n]));
  for (const g of goals) {
    const links = linksBy.get(g.id) ?? [];
    const value = goalValue(links, values, transferred.get(g.id) ?? 0).value;
    await db.prepare("INSERT OR REPLACE INTO goal_snapshots (goal_id, date, value_sgd_minor) VALUES (?,?,?)").bind(g.id, today, value).run();
    const horizon = horizonFor(g.target_date, today, g.kind);
    await db.prepare("UPDATE goals SET horizon = ?, target_sgd_minor = ? WHERE id = ?").bind(horizon, goalTarget(g, today), g.id).run();
    if (!saferFundingPrompt(g.horizon, horizon, hasRiskyFunding(links, (id) => kinds.get(id)))) continue;
    const claimed = await db.prepare("INSERT OR IGNORE INTO alert_log (id, kind, ref, period, sent_at) VALUES (?,?,?,?,?)").bind(ulid(), SAFER_FUNDING_KIND, g.id, "once", deps.now().toISOString()).run();
    if (!claimed.meta.changes) continue;
    await sendNudge(env, deps, {
      title: "Okanary: goals",
      body: `‘${g.name}’ is now under 2 years away. Fund it from cash instead of stocks/crypto? Money needed soon shouldn't depend on market swings.`,
      url: `/money/goals/${g.id}`, tag: `safer-${g.id}`,
    }, SAFER_FUNDING_KIND);
  }
}

// ---------------------------------------------------------------- weekly underspend pledges

/** True at SGT 00:xx on the first day of the week (week_start setting, Monday by default): the hourly cron's trigger. */
export async function underspendDue(env: Env, deps: Deps): Promise<boolean> {
  const now = deps.now();
  if (sgtParts(now).hour !== 0) return false;
  return dayOfWeek(sgtDate(now)) === (await loadAllowanceSettings(env.DB)).weekStart;
}

export interface UnderspendResult { created: string | null; amount: number; period: string | null; reason?: "no_allowance" | "no_underspend" | "no_goal" | "already_pledged" }

/**
 * The week that just ended (the one before the current SGT week): amount = max(0, allowance − Lifestyle spent) becomes a
 * 'pledged' contribution on the receiving goal, plus one nudge. Safe to run twice (partial unique index: one underspend
 * pledge per period); the nudge only goes out when the row was newly inserted.
 */
export async function runUnderspendPledges(env: Env, deps: Deps): Promise<UnderspendResult> {
  const now = deps.now();
  const { weekStart } = await loadAllowanceSettings(env.DB);
  const ended = weekOf(shiftWeek(sgtWeek(now, weekStart).startDate, -1));
  const state = await loadWeekAllowance(env.DB, new Date(Date.parse(ended.end) - 1));
  const none = (reason: UnderspendResult["reason"], amount = 0): UnderspendResult => ({ created: null, amount, period: ended.label, reason });
  if (!state.allowance.hasAllowance) return none("no_allowance");
  const amount = underspendAmount(state.allowance.total, state.spent);
  if (amount <= 0) return none("no_underspend");

  const { goals, receiving_goal_id } = await loadGoals(env.DB, now);
  const goal = goals.find((g) => g.id === receiving_goal_id);
  if (!goal) return none("no_goal", amount);

  const id = ulid(now.getTime());
  const r = await env.DB.prepare("INSERT OR IGNORE INTO goal_contributions (id, goal_id, period, amount_sgd_minor, source, status, created_at) VALUES (?,?,?,?,'underspend','pledged',?)")
    .bind(id, goal.id, ended.label, amount, now.toISOString()).run();
  if (!r.meta.changes) return none("already_pledged", amount);
  const label = goal.emoji ? `${goal.emoji} ${goal.name}` : goal.name;
  await sendNudge(env, deps, {
    title: "Okanary: goals",
    body: `Last week you came in ${formatMoneyShort(amount)} under. Move ${formatMoneyShort(amount)} to ${label}?`,
    url: `/money/goals?pledge=${id}`, tag: "underspend", pledge: id, actions: "transfer,skip",
  }, "underspend_pledge");
  return { created: id, amount, period: ended.label };
}
