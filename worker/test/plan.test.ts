import { env } from "cloudflare:test";
import { horizonFor, weeklyFromMonthly } from "@okanary/core";
import { beforeEach, describe, expect, it } from "vitest";
import { sendMonthlySummary } from "../src/networth-summary";
import { _resetRateLimit } from "../src/routes/ingest";
import { count, harness, json, resetDb } from "./helpers";

beforeEach(async () => { _resetRateLimit(); await resetDb(); });

const NOON = new Date("2026-10-14T04:00:00Z"); // Wed 14 Oct 2026 12:00 SGT; the week is Mon 12 – Sun 18 Oct
const NOV_1 = new Date("2026-11-01T01:00:00Z"); // 1 Nov 2026 09:00 SGT (monthly summary time)
const WEEK = "2026-10-12";

type H = ReturnType<typeof harness>;
type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const api = async (h: H, method: string, path: string, body?: unknown) => {
  const r = await h.call(path, body === undefined ? { method } : json(method, body));
  return { status: r.status, body: (await r.json()) as Obj };
};
const ok = async (h: H, method: string, path: string, body?: unknown): Promise<Obj> => {
  const r = await api(h, method, path, body);
  expect(r.status, `${method} ${path} ${JSON.stringify(r.body)}`).toBeLessThan(300);
  return r.body;
};

let seq = 0;
async function txn(minor: number, category: string, occurred_at: string, recurring_id: string | null = null) {
  await env.DB.prepare("INSERT INTO transactions (id, occurred_at, amount_minor, currency, amount_sgd_minor, status, source, category_id, recurring_id, created_at, updated_at) VALUES (?,?,?,?,?,'confirmed','manual',?,?,'x','x')")
    .bind(`p${++seq}`, occurred_at, minor, "SGD", minor, category, recurring_id).run();
  return `p${seq}`;
}
const sub = (id: string, name: string, amount: number, cycle: "monthly" | "yearly") =>
  env.DB.prepare("INSERT INTO subscriptions (id, name, merchant_pattern, amount_minor, currency, cycle, next_renewal, expected_sgd_minor, category_id, source, status, created_at) VALUES (?,?,?,?,'SGD',?,'2026-11-01',?,'subscriptions','manual','active','2026-01-01T00:00:00Z')")
    .bind(id, name, name.toUpperCase(), amount, cycle, amount).run();

/** Jul–Sep 2026: rent S$2,000 and groceries S$600 a month, a subscription-linked phone charge (excluded from the Essentials baseline),
 *  Lifestyle S$1,850 / 1,950 / 2,050 plus the S$50 subscription charge → a Lifestyle average of exactly S$2,000. */
async function history() {
  await sub("sub-m", "Netflix", 5000, "monthly");
  await sub("sub-y", "Domain", 13000, "yearly"); // set-aside ceil(13000 / 12) = 1,084
  const lifestyle = { "2026-07": 185000, "2026-08": 195000, "2026-09": 205000 };
  for (const [m, l] of Object.entries(lifestyle)) {
    await txn(200000, "rent", `${m}-01T04:00:00Z`);
    await txn(60000, "groceries", `${m}-10T04:00:00Z`);
    await txn(3000, "utilities", `${m}-12T04:00:00Z`, "sub-m"); // Essentials, linked to a subscription
    await txn(l, "food", `${m}-15T04:00:00Z`);
    await txn(5000, "subscriptions", `${m}-20T04:00:00Z`, "sub-m"); // Lifestyle, linked to a subscription (still Lifestyle spend)
  }
}
/** Emergency fund S$12,000 (no date → 12-month horizon, S$1,000/month) and a S$6,000 goal due in exactly 12 months (S$500/month); 0% return for exact numbers. */
async function twoGoals(h: H) {
  const em = await ok(h, "POST", "/api/goals", { name: "Emergency fund", kind: "emergency", target_today_minor: 1200000, return_bp: 0 });
  const trip = await ok(h, "POST", "/api/goals", { name: "Japan trip", kind: "short", target_today_minor: 600000, target_date: "2027-10-14", return_bp: 0 });
  return { em: em.id as string, trip: trip.id as string };
}
const setBase = (h: H, base_takehome_minor: number, effective_from?: string) => ok(h, "PUT", "/api/income/base", { base_takehome_minor, ...(effective_from ? { effective_from } : {}) });
const getPlan = (h: H, month?: string) => ok(h, "GET", `/api/plan${month ? `?month=${month}` : ""}`);
const goalRow = async (id: string) => (await env.DB.prepare("SELECT * FROM goals WHERE id = ?").bind(id).first<Obj>())!;

describe("plan: feasible", () => {
  it("builds the plan from base income, subscriptions, Essentials/Lifestyle history and goals; caps Lifestyle with the overflow going to goals", async () => {
    const h = harness({ now: NOON });
    await history();
    const { em, trip } = await twoGoals(h);
    await setBase(h, 600000);
    const r = await getPlan(h);
    expect(r.month).toBe("2026-10");
    // the inputs: subscription-linked charges (phone S$30) are not in the Essentials baseline; lines are per category
    expect(r.inputs.subscriptions).toEqual({ monthly: 5000, setAside: 1084 });
    expect(r.inputs.essentials).toEqual([{ key: "groceries", label: "Groceries", amount: 60000 }, { key: "rent", label: "Rent/Housing", amount: 200000 }]);
    expect(r.inputs.lifestyleAverage).toBe(200000);
    expect(r.inputs.commissionHistory).toEqual([]);
    expect(r.inputs.goals.map((g: Obj) => [g.id, g.priority, g.return_bp])).toEqual([[em, 1, 0], [trip, 2, 0]]);
    // fixed = 50 + 10.84 + 600 + 2,000; goals = 1,000 + 500; L = 6,000 − 2,660.84 − 1,500
    expect(r.plan.fixed.lines.map((l: Obj) => [l.key, l.amount])).toEqual([["subscriptions", 5000], ["set_aside", 1084], ["groceries", 60000], ["rent", 200000]]);
    expect(r.plan.fixed.total).toBe(266084);
    expect(r.plan.goals.allocations.map((a: Obj) => [a.id, a.required, a.extra, a.total])).toEqual([[em, 100000, 0, 100000], [trip, 50000, 0, 50000]]);
    expect(r.plan).toMatchObject({ available: 183916, floor: 120000, cap: 220000, feasible: true, lifestyle: 183916, unallocated: 0, shortfall: 0, tradeOffs: [] });
    expect(r.accepted).toBeNull();
    expect(r.lifestyle_budget).toBeNull();
    expect(r.budget_source).toBe("none");
    expect(r.assumptions).toMatchObject({ floor_pct: 60, cap_pct: 10, emergency_months: 6 });
    expect(r.assumptions.goals).toEqual([{ id: em, name: "Emergency fund", return_bp: 0, inflation_bp: null }, { id: trip, name: "Japan trip", return_bp: 0, inflation_bp: null }]);
    expect(r.references.map((x: Obj) => x.name)).toEqual(["50/30/20", "60/20/20 (Singapore)"]);
    expect(r.disclaimer).toBe("Estimates, not financial advice.");

    // a higher base: Lifestyle is capped at 110% of the average and the rest goes to goals in priority order
    await setBase(h, 700000);
    const capped = (await getPlan(h)).plan;
    expect(capped).toMatchObject({ available: 283916, cap: 220000, feasible: true, lifestyle: 220000, unallocated: 0 });
    expect(capped.goals.allocations.map((a: Obj) => [a.id, a.required, a.extra, a.total])).toEqual([[em, 100000, 63916, 163916], [trip, 50000, 0, 50000]]);
    expect(capped.goals.total).toBe(213916);
    const { needs, savings, wants } = capped.split;
    expect(needs + savings + wants).toBe(100);
    expect(capped.splitText).toBe(`Your plan: ${needs} / ${savings} / ${wants} (needs / savings / wants)`);
  });

  it("annual set-asides are included in the fixed costs (a yearly S$1,200 subscription = S$100/month); trials and cancelled ones are not", async () => {
    const h = harness({ now: NOON });
    await sub("y1", "Insurance rider", 120000, "yearly");
    await env.DB.prepare("INSERT INTO subscriptions (id, name, amount_minor, currency, cycle, expected_sgd_minor, source, status) VALUES ('t1','Trial','900','SGD','monthly',900,'manual','trial'), ('c1','Old','900','SGD','monthly',900,'manual','cancelled')").run();
    await setBase(h, 500000);
    const r = await getPlan(h);
    expect(r.inputs.subscriptions).toEqual({ monthly: 0, setAside: 10000 });
    expect(r.plan.fixed.lines.find((l: Obj) => l.key === "set_aside")).toMatchObject({ amount: 10000 });
    expect(r.plan.fixed.total).toBe(10000);
  });

  it("settings: line overrides and a Lifestyle floor feed the plan", async () => {
    const h = harness({ now: NOON });
    await history();
    await setBase(h, 600000);
    expect(await ok(h, "PUT", "/api/plan/settings", { overrides: { rent: 250000, nanny: 10000 }, lifestyle_floor_minor: 100000 })).toEqual({ overrides: { rent: 250000, nanny: 10000 }, lifestyle_floor_minor: 100000 });
    const p = (await getPlan(h)).plan;
    expect(p.fixed.lines.find((l: Obj) => l.key === "rent")).toMatchObject({ amount: 250000, overridden: true });
    expect(p.fixed.lines.find((l: Obj) => l.key === "nanny")).toMatchObject({ amount: 10000, overridden: true });
    expect(p.floor).toBe(100000);
    expect(p.fixed.total).toBe(5000 + 1084 + 60000 + 250000 + 10000);
    expect((await api(h, "PUT", "/api/plan/settings", { overrides: { rent: -1 } })).status).toBe(400);
    expect(await ok(h, "PUT", "/api/plan/settings", { overrides: null, lifestyle_floor_minor: null })).toEqual({ overrides: {}, lifestyle_floor_minor: null });
    expect((await getPlan(h)).plan.floor).toBe(120000);
  });
});

describe("plan: infeasible", () => {
  it("a low base is infeasible and gets computed trade-offs (extend dates, lower Lifestyle with the weekly figure); the commission option needs 3 months of commission history", async () => {
    const h = harness({ now: NOON });
    await history();
    const { trip } = await twoGoals(h);
    await setBase(h, 500000);
    const r = await getPlan(h);
    // L = 5,000 − 2,660.84 − 1,500 = 839.16, below the floor of 1,200
    expect(r.plan).toMatchObject({ available: 83916, floor: 120000, feasible: false, shortfall: 36084, lifestyle: 83916 });
    const kinds = r.plan.tradeOffs.map((t: Obj) => t.kind);
    expect(kinds).toEqual(["extend", "lower_lifestyle"]);
    const ext = r.plan.tradeOffs[0];
    expect(ext.changes).toHaveLength(1); // the lowest-priority goal with a date; the emergency fund has none
    expect(ext.changes[0]).toMatchObject({ id: trip, name: "Japan trip", from: "2027-10-14" });
    expect(ext.changes[0].to > "2027-10-14").toBe(true);
    expect(ext.changes[0].required).toBeLessThanOrEqual(50000 - 36084);
    expect(ext.covers).toBe(true);
    expect(r.plan.tradeOffs[1]).toEqual({ kind: "lower_lifestyle", lifestyle: 83916, weekly: weeklyFromMonthly(83916, "2026-10") });

    // commission: two months of history is not enough, three (a month without commission counts as 0) is
    await ok(h, "POST", "/api/income/events", { kind: "commission", amount_minor: 60000, received_on: "2026-07-20" });
    await ok(h, "POST", "/api/income/events", { kind: "commission", amount_minor: 30000, received_on: "2026-09-18" });
    expect((await getPlan(h)).inputs.commissionHistory).toEqual([30000, 0, 60000]);
    const withCommission = (await getPlan(h)).plan.tradeOffs;
    expect(withCommission.map((t: Obj) => t.kind)).toEqual(["extend", "lower_lifestyle", "commission"]);
    expect(withCommission[2]).toEqual({ kind: "commission", shortfall: 36084, commissionNeeded: Math.ceil(36084 / 0.7), averageCommission: 30000, covered: false });
    // commission in the current month alone doesn't make a history
    await resetCommission();
    await ok(h, "POST", "/api/income/events", { kind: "commission", amount_minor: 60000, received_on: "2026-10-05" });
    expect((await getPlan(h)).inputs.commissionHistory).toEqual([]);
    await resetCommission();
    await ok(h, "POST", "/api/income/events", { kind: "commission", amount_minor: 60000, received_on: "2026-08-05" });
    await ok(h, "POST", "/api/income/events", { kind: "commission", amount_minor: 10000, received_on: "2026-09-05" });
    expect((await getPlan(h)).plan.tradeOffs.map((t: Obj) => t.kind)).toEqual(["extend", "lower_lifestyle"]);
  });
});

const resetCommission = () => env.DB.exec("DELETE FROM income_events");

describe("plan: accept", () => {
  it("writes the month's Lifestyle budget and every goal's planned monthly; A's weekly allowance follows; a manual budget edit reads as manual", async () => {
    const h = harness({ now: NOON });
    await history();
    const { em, trip } = await twoGoals(h);
    const archived = await ok(h, "POST", "/api/goals", { name: "Old goal", kind: "short", target_today_minor: 100000, target_date: "2027-01-14" });
    await ok(h, "DELETE", `/api/goals/${archived.id}`);
    await env.DB.prepare("UPDATE goals SET planned_monthly_minor = 777 WHERE id = ?").bind(archived.id).run();
    await setBase(h, 600000);
    expect((await ok(h, "GET", "/api/allowance")).allowance.hasAllowance).toBe(false);

    const r = await ok(h, "POST", "/api/plan/accept", {});
    expect(r.plan.lifestyle).toBe(183916);
    expect(r.accepted).toMatchObject({ month: "2026-10", accepted: true, outputs: { lifestyle: 183916 } });
    expect(r.accepted.accepted_at).toBe(NOON.toISOString());
    expect(r.lifestyle_budget).toBe(183916);
    expect(r.budget_source).toBe("plan");
    const b = await env.DB.prepare("SELECT monthly_amount_sgd_minor AS n, effective_from FROM budgets WHERE scope = 'group' AND ref_id = 'lifestyle'").all<{ n: number; effective_from: string }>();
    expect(b.results).toEqual([{ n: 183916, effective_from: "2026-10" }]);
    expect((await goalRow(em)).planned_monthly_minor).toBe(100000);
    expect((await goalRow(trip)).planned_monthly_minor).toBe(50000);
    expect((await goalRow(archived.id)).planned_monthly_minor).toBeNull();
    const goals = await ok(h, "GET", "/api/goals");
    expect(goals.goals.map((g: Obj) => g.planned_monthly_minor)).toEqual([100000, 50000]);

    // A's weekly allowance for Mon 12 – Sun 18 Oct comes from that budget (cumulative per-month rounding, D-47)
    const al = await ok(h, "GET", "/api/allowance");
    expect(al.allowance.hasAllowance).toBe(true);
    expect(al.allowance.total).toBe(Math.round((183916 * 18) / 31) - Math.round((183916 * 11) / 31));
    expect(al.month.budget).toBe(183916);

    // accepting again replaces the accepted row (one accepted plan per month) and does not duplicate the budget
    await ok(h, "POST", "/api/plan/accept", {});
    expect(await count("SELECT COUNT(*) AS n FROM plans WHERE accepted = 1")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM plans")).toBe(2);
    expect(await count("SELECT COUNT(*) AS n FROM budgets WHERE ref_id = 'lifestyle'")).toBe(1);

    // a manual edit afterwards
    await ok(h, "PUT", "/api/budgets", { scope: "group", ref_id: "lifestyle", month: "2026-10", amount_sgd_minor: 190000 });
    const after = await getPlan(h);
    expect(after.budget_source).toBe("manual");
    expect(after.lifestyle_budget).toBe(190000);
    expect(after.accepted.outputs.lifestyle).toBe(183916);
  });

  it("with extend, the extend trade-off's new dates are applied to those goals first and the accepted plan reflects them", async () => {
    const h = harness({ now: NOON });
    await history();
    const { em, trip } = await twoGoals(h);
    await setBase(h, 500000);
    const before = await getPlan(h);
    expect(before.plan.feasible).toBe(false);
    const change = before.plan.tradeOffs[0].changes[0];

    const r = await ok(h, "POST", "/api/plan/accept", { extend: true });
    const g = await goalRow(trip);
    expect(g.target_date).toBe(change.to);
    expect(g.horizon).toBe(horizonFor(change.to, "2026-10-14", "short"));
    expect(g.target_sgd_minor).toBe(600000);
    expect((await goalRow(em)).target_date).toBeNull();
    expect(r.plan.feasible).toBe(true);
    expect(r.accepted.inputs.goals.find((x: Obj) => x.id === trip).target_date).toBe(change.to);
    const alloc = r.plan.goals.allocations.find((a: Obj) => a.id === trip);
    expect(alloc.required).toBe(change.required);
    expect((await goalRow(trip)).planned_monthly_minor).toBe(alloc.total);
    expect(r.lifestyle_budget).toBe(r.plan.lifestyle);
    expect(r.plan.lifestyle).toBe(500000 - 266084 - 100000 - change.required);

    // without extend an infeasible plan is accepted as it is (Lifestyle = what is left) and no date moves
    await resetPlanState(trip);
    const r2 = await ok(h, "POST", "/api/plan/accept", {});
    expect(r2.plan.feasible).toBe(false);
    expect((await goalRow(trip)).target_date).toBe("2027-10-14");
    expect(r2.lifestyle_budget).toBe(83916);
  });

  it("without a base income: GET answers needs_income and accept is refused", async () => {
    const h = harness({ now: NOON });
    expect(await getPlan(h)).toEqual({ month: "2026-10", needs_income: true });
    const r = await api(h, "POST", "/api/plan/accept", {});
    expect(r.status).toBe(409);
    expect(r.body.needs_income).toBe(true);
    expect(await count("SELECT COUNT(*) AS n FROM plans")).toBe(0);
    expect((await api(h, "GET", "/api/plan?month=2026-13")).status).toBe(400);
  });
});

async function resetPlanState(goalId: string) {
  await env.DB.exec("DELETE FROM plans; DELETE FROM budgets");
  await env.DB.prepare("UPDATE goals SET target_date = '2027-10-14' WHERE id = ?").bind(goalId).run();
}

describe("income", () => {
  it("base income upserts by effective month; the row in force for a month is the latest effective_from <= month", async () => {
    const h = harness({ now: NOON });
    const start = await ok(h, "GET", "/api/income");
    expect(start).toMatchObject({ base: null, history: [], events: [], candidates: [], split_rule: { goals_bp: 7000, fun_bp: 2000, buffer_bp: 1000 } });
    const a = await setBase(h, 500000);
    expect(a.base).toMatchObject({ base_takehome_minor: 500000, currency: "SGD", effective_from: "2026-10" });
    const b = await setBase(h, 600000); // same month: updated, not added
    expect(b.history).toHaveLength(1);
    expect(b.base.base_takehome_minor).toBe(600000);
    expect(b.base.id).toBe(a.base.id);
    const c = await setBase(h, 650000, "2026-12");
    expect(c.history.map((x: Obj) => [x.effective_from, x.base_takehome_minor])).toEqual([["2026-12", 650000], ["2026-10", 600000]]);
    expect(c.base.base_takehome_minor).toBe(600000); // December's raise isn't in force yet
    expect((await getPlan(h, "2026-12")).inputs.income).toBe(650000);
    expect((await getPlan(h, "2026-11")).inputs.income).toBe(600000);
    expect(await getPlan(h, "2026-09")).toEqual({ month: "2026-09", needs_income: true });
    expect((await api(h, "PUT", "/api/income/base", { base_takehome_minor: -1 })).status).toBe(400);
    expect((await api(h, "PUT", "/api/income/base", { base_takehome_minor: 1.5 })).status).toBe(400);
    expect((await api(h, "PUT", "/api/income/base", { base_takehome_minor: 100, effective_from: "2026-1" })).status).toBe(400);
    expect((await setBase(h, 0)).base.base_takehome_minor).toBe(0);
  });

  it("split rule: each share 0..10000 and the three add up to 10000; the stored rule drives new proposals", async () => {
    const h = harness({ now: NOON });
    for (const bad of [
      { goals_bp: 6000, fun_bp: 3000, buffer_bp: 2000 }, // 11,000
      { goals_bp: 5000, fun_bp: 2000, buffer_bp: 1000 }, // 8,000
      { goals_bp: 10001, fun_bp: 0, buffer_bp: -1 },
      { goals_bp: 7000, fun_bp: 2000 },
      { goals_bp: 70.5, fun_bp: 19.5, buffer_bp: 9910 },
    ]) expect((await api(h, "PUT", "/api/income/split-rule", bad)).status).toBe(400);
    expect(await ok(h, "PUT", "/api/income/split-rule", { goals_bp: 5000, fun_bp: 3000, buffer_bp: 2000 })).toEqual({ goals_bp: 5000, fun_bp: 3000, buffer_bp: 2000 });
    expect((await ok(h, "GET", "/api/income")).split_rule).toEqual({ goals_bp: 5000, fun_bp: 3000, buffer_bp: 2000 });
    expect((await ok(h, "PUT", "/api/income/split-rule", { goals_bp: 0, fun_bp: 10000, buffer_bp: 0 })).fun_bp).toBe(10000);
    await ok(h, "PUT", "/api/income/split-rule", { goals_bp: 5000, fun_bp: 3000, buffer_bp: 2000 });
    const ev = await ok(h, "POST", "/api/income/events", { kind: "commission", amount_minor: 100000 });
    expect(ev.split).toMatchObject({ goals: 50000, fun: 30000, buffer: 20000, bonus: 30000, pledges: [], unallocated: 70000 }); // no goals yet
  });
});

describe("commission", () => {
  async function commissionGoals(h: H) {
    // a tiny first goal so the priority order shows: S$300 emergency fund, then a S$6,000 goal
    const em = await ok(h, "POST", "/api/goals", { name: "Emergency fund", kind: "emergency", target_today_minor: 30000, return_bp: 0 });
    const trip = await ok(h, "POST", "/api/goals", { name: "Japan trip", kind: "short", target_today_minor: 600000, target_date: "2027-10-14", return_bp: 0 });
    return { em: em.id as string, trip: trip.id as string };
  }

  it("proposes 70/20/10 with pledges filling goals in priority order; confirm creates 'commission' pledges and a lifestyle bonus that raises this week's allowance; a second confirm is refused", async () => {
    const h = harness({ now: NOON });
    const { em, trip } = await commissionGoals(h);
    await ok(h, "PUT", "/api/budgets", { scope: "group", ref_id: "lifestyle", month: "2026-10", amount_sgd_minor: 310000 });
    const before = (await ok(h, "GET", "/api/allowance")).allowance;

    const ev = await ok(h, "POST", "/api/income/events", { kind: "commission", amount_minor: 100000 });
    expect(ev).toMatchObject({ kind: "commission", amount_minor: 100000, received_on: "2026-10-14", transaction_id: null, split_status: "proposed" });
    expect(ev.split).toEqual({
      goals: 70000, fun: 20000, buffer: 10000, bonus: 20000, unallocated: 0,
      pledges: [{ goal_id: em, amount: 30000, part: "goals" }, { goal_id: trip, amount: 40000, part: "goals" }, { goal_id: trip, amount: 10000, part: "buffer" }],
    });
    // nothing happens until it is confirmed
    expect(await count("SELECT COUNT(*) AS n FROM goal_contributions")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM lifestyle_bonus")).toBe(0);
    expect((await ok(h, "GET", "/api/allowance")).allowance.total).toBe(before.total);

    const done = await ok(h, "POST", `/api/income/events/${ev.id}/confirm`);
    expect(done.split_status).toBe("confirmed");
    const pledges = (await env.DB.prepare("SELECT goal_id, period, amount_sgd_minor, source, status, resolved_at FROM goal_contributions ORDER BY amount_sgd_minor").all<Obj>()).results;
    expect(pledges).toEqual([
      { goal_id: trip, period: "2026-10", amount_sgd_minor: 10000, source: "commission", status: "pledged", resolved_at: null },
      { goal_id: em, period: "2026-10", amount_sgd_minor: 30000, source: "commission", status: "pledged", resolved_at: null },
      { goal_id: trip, period: "2026-10", amount_sgd_minor: 40000, source: "commission", status: "pledged", resolved_at: null },
    ]);
    const bonus = await env.DB.prepare("SELECT week_start, amount_sgd_minor, source FROM lifestyle_bonus").all<Obj>();
    expect(bonus.results).toEqual([{ week_start: WEEK, amount_sgd_minor: 20000, source: `commission:${ev.id}` }]);
    // the guilt-free share is spendable this week, everywhere the allowance is read
    const after = (await ok(h, "GET", "/api/allowance"));
    expect(after.allowance.bonus).toBe(20000);
    expect(after.allowance.total).toBe(before.total + 20000);
    // the goals now show the pledges (apart from progress)
    const g = (await ok(h, "GET", "/api/goals")).goals.find((x: Obj) => x.id === trip);
    expect(g.totals.pledged).toBe(50000);

    // idempotent: a second confirm, a skip or a delete of a confirmed event change nothing
    expect((await api(h, "POST", `/api/income/events/${ev.id}/confirm`)).status).toBe(409);
    expect((await api(h, "POST", `/api/income/events/${ev.id}/skip`)).status).toBe(409);
    expect((await api(h, "DELETE", `/api/income/events/${ev.id}`)).status).toBe(409);
    expect(await count("SELECT COUNT(*) AS n FROM goal_contributions")).toBe(3);
    expect(await count("SELECT COUNT(*) AS n FROM lifestyle_bonus")).toBe(1);
    expect((await api(h, "POST", "/api/income/events/nope/confirm")).status).toBe(404);

    // pledged money counts as already coming: the next proposal skips the full emergency fund
    const next = await ok(h, "POST", "/api/income/events", { kind: "bonus", amount_minor: 50000 });
    expect(next.split.pledges.map((p: Obj) => p.goal_id)).toEqual([trip, trip]);
    expect(next.split.pledges.reduce((a: number, p: Obj) => a + p.amount, 0)).toBe(40000);
  });

  it("the bonus lands in the week of confirmation (follows week_start) and flows into the carry-over chain", async () => {
    const h = harness({ now: NOON });
    await ok(h, "PUT", "/api/budgets", { scope: "group", ref_id: "lifestyle", month: "2026-10", amount_sgd_minor: 310000 }); // S$100/day
    await ok(h, "PUT", "/api/settings", { allowance_carry: true });
    // a bonus on the earlier week of the same month's chain (Mon 5 Oct), nothing spent: it carries into this week
    await env.DB.prepare("INSERT INTO lifestyle_bonus (id, week_start, amount_sgd_minor, source, created_at) VALUES ('b1','2026-10-05',5000,'commission:x','x'), ('b2','2026-10-05',2500,'commission:y','x')").run();
    const al = (await ok(h, "GET", "/api/allowance")).allowance;
    expect(al.carry).toBe(70000 + 5000 + 2500);
    expect(al.bonus).toBe(0);
    expect(al.total).toBe(70000 + 77500);

    // Sunday week start: confirming on Wed 14 Oct books the bonus on Sun 11 Oct
    await ok(h, "PUT", "/api/settings", { week_start: 0, allowance_carry: false });
    const ev = await ok(h, "POST", "/api/income/events", { kind: "commission", amount_minor: 100000 });
    await ok(h, "POST", `/api/income/events/${ev.id}/confirm`);
    expect((await env.DB.prepare("SELECT week_start FROM lifestyle_bonus WHERE source = ?").bind(`commission:${ev.id}`).first<Obj>())!.week_start).toBe("2026-10-11");
    expect((await ok(h, "GET", "/api/allowance")).allowance.bonus).toBe(20000);
  });

  it("'other' income is logged without a split; skip and delete work only while proposed; input is validated", async () => {
    const h = harness({ now: NOON });
    await commissionGoals(h);
    const other = await ok(h, "POST", "/api/income/events", { kind: "other", amount_minor: 4200, received_on: "2026-10-02" });
    expect(other).toMatchObject({ kind: "other", split_status: "skipped", split: null, split_json: null, received_on: "2026-10-02" });
    expect((await api(h, "DELETE", `/api/income/events/${other.id}`)).status).toBe(409);
    expect((await api(h, "POST", `/api/income/events/${other.id}/confirm`)).status).toBe(409);

    const a = await ok(h, "POST", "/api/income/events", { kind: "commission", amount_minor: 100000 });
    expect((await ok(h, "POST", `/api/income/events/${a.id}/skip`)).split_status).toBe("skipped");
    expect((await api(h, "POST", `/api/income/events/${a.id}/confirm`)).status).toBe(409);
    expect(await count("SELECT COUNT(*) AS n FROM goal_contributions")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM lifestyle_bonus")).toBe(0);

    const b = await ok(h, "POST", "/api/income/events", { kind: "bonus", amount_minor: 100000 });
    expect((await ok(h, "DELETE", `/api/income/events/${b.id}`)).deleted).toBe(true);
    expect((await api(h, "DELETE", `/api/income/events/${b.id}`)).status).toBe(404);

    for (const bad of [{ kind: "salary", amount_minor: 100 }, { kind: "commission", amount_minor: 0 }, { kind: "commission", amount_minor: 1.5 }, { kind: "commission", amount_minor: 100, received_on: "2026-02-30" }, { kind: "commission", amount_minor: 100, transaction_id: "nope" }]) {
      expect((await api(h, "POST", "/api/income/events", bad)).status, JSON.stringify(bad)).toBe(400);
    }
    // events listed newest first, last 12 months only
    await env.DB.prepare("INSERT INTO income_events (id, kind, amount_minor, received_on, split_status) VALUES ('old','commission',100,'2025-09-30','confirmed'), ('edge','commission',100,'2025-11-01','confirmed')").run();
    const list = (await ok(h, "GET", "/api/income")).events;
    expect(list.map((e: Obj) => e.id)).toContain("edge");
    expect(list.map((e: Obj) => e.id)).not.toContain("old");
    expect(list.map((e: Obj) => e.received_on)).toEqual([...list.map((e: Obj) => e.received_on)].sort().reverse());
  });

  it("candidates list unlogged Other-income transactions of the last 60 days (not Salary) and drop one once it is logged", async () => {
    const h = harness({ now: NOON });
    const t1 = await txn(150000, "other_income", "2026-10-02T04:00:00Z");
    await txn(600000, "salary", "2026-10-01T04:00:00Z");
    await txn(90000, "other_income", "2026-07-01T04:00:00Z"); // older than 60 days
    await txn(5000, "food", "2026-10-03T04:00:00Z"); // not income
    const t2 = await txn(20000, "other_income", "2026-09-20T04:00:00Z");
    const c0 = (await ok(h, "GET", "/api/income")).candidates;
    expect(c0.map((c: Obj) => c.id)).toEqual([t1, t2]);
    expect(c0[0]).toMatchObject({ amount_sgd_minor: 150000, category_id: "other_income" });

    const ev = await ok(h, "POST", "/api/income/events", { kind: "commission", amount_minor: 150000, transaction_id: t1 });
    expect(ev.transaction_id).toBe(t1);
    expect(ev.received_on).toBe("2026-10-02"); // dated by the transaction unless the caller says otherwise
    expect((await ok(h, "GET", "/api/income")).candidates.map((c: Obj) => c.id)).toEqual([t2]);
    const dup = await api(h, "POST", "/api/income/events", { kind: "bonus", amount_minor: 150000, transaction_id: t1 });
    expect(dup.status).toBe(409);
    expect(await count("SELECT COUNT(*) AS n FROM income_events")).toBe(1);
    // deleting the proposed event frees the transaction again
    await ok(h, "DELETE", `/api/income/events/${ev.id}`);
    expect((await ok(h, "GET", "/api/income")).candidates.map((c: Obj) => c.id)).toEqual([t1, t2]);
  });
});

describe("monthly check-in", () => {
  it("the 1st-of-month summary has last month's plan vs actual, the new month's plan and the commission splits to confirm", async () => {
    const h = harness({ now: NOON });
    await history();
    const { em } = await twoGoals(h);
    await setBase(h, 600000);
    await ok(h, "POST", "/api/plan/accept", {}); // October: fixed S$2,660.84 · goals S$1,500 · lifestyle S$1,839.16

    // what actually happened in October
    await txn(200000, "rent", "2026-10-01T04:00:00Z");
    await txn(61000, "groceries", "2026-10-09T04:00:00Z");
    await txn(5000, "subscriptions", "2026-10-20T04:00:00Z", "sub-m"); // subscription charge: counts as fixed, not Lifestyle
    await txn(150000, "food", "2026-10-15T04:00:00Z");
    await txn(50000, "savings", "2026-10-25T04:00:00Z"); // Savings group: not spend
    await env.DB.prepare("INSERT INTO goal_contributions (id, goal_id, period, amount_sgd_minor, source, status, created_at, resolved_at) VALUES ('c1',?,'manual',80000,'manual','transferred','2026-10-05T00:00:00Z','2026-10-21T04:00:00Z'), ('c2',?,'manual',30000,'manual','transferred','2026-11-01T00:00:00Z','2026-11-01T00:30:00Z'), ('c3',?,'manual',99900,'manual','pledged','2026-10-05T00:00:00Z',NULL)")
      .bind(em, em, em).run();

    h.setNow(NOV_1);
    await ok(h, "PUT", "/api/settings", { nudge_daily_limit: 20 });
    await ok(h, "POST", "/api/income/events", { kind: "commission", amount_minor: 100000, received_on: "2026-10-30" });
    await ok(h, "POST", "/api/income/events", { kind: "bonus", amount_minor: 100000, received_on: "2026-10-31" });
    const r = await sendMonthlySummary(h.e, h.deps);
    expect(r.sent).toBe(true);
    expect(r.body).toContain("Plan vs actual (Oct): fixed S$2,660 (plan S$2,661) · goals S$800 (plan S$1,500) · lifestyle S$1,500 (plan S$1,839)");
    expect(r.body).toMatch(/New plan for Nov: lifestyle S\$[\d,]+/);
    expect(r.body).toContain("2 commission splits to confirm");
    const lines = r.body!.split(" · ");
    expect(lines.findIndex((l) => l.startsWith("Plan vs actual"))).toBeLessThan(lines.findIndex((l) => l.startsWith("New plan for Nov")));
    expect(r.body).not.toMatch(/overspent|failed|bad|over budget/i);
  });

  it("without an accepted plan or income there are no plan lines; a single proposed split reads in the singular", async () => {
    const h = harness({ now: NOV_1 });
    expect((await sendMonthlySummary(h.e, h.deps)).sent).toBe(false);
    await env.DB.prepare("INSERT INTO income_events (id, kind, amount_minor, received_on, split_json, split_status) VALUES ('e1','commission',100000,'2026-10-30',NULL,'proposed')").run();
    const r = await sendMonthlySummary(h.e, h.deps);
    expect(r.body).toBe("October: 1 commission split to confirm");
    await env.DB.exec("DELETE FROM alert_log");
    await setBase(h, 500000);
    const r2 = await sendMonthlySummary(h.e, h.deps);
    expect(r2.body).toMatch(/^October: New plan for Nov: lifestyle S\$[\d,]+ · 1 commission split to confirm$/);
    expect(r2.body).not.toContain("Plan vs actual");
  });
});
