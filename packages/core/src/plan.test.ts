import { describe, expect, it } from "vitest";
import { buildPlan, commissionSplit, DEFAULT_SPLIT, percentages, planVsActual, type PlanGoal, type PlanInput } from "./plan";
import { subscriptionFixedCosts } from "./subscriptions";

const TODAY = "2026-10-14";
const emergency: PlanGoal = { id: "ef", name: "Emergency fund", priority: 1, kind: "emergency", target_today_minor: 1_200_000, inflation_bp: null, return_bp: 0, target_date: null, value: 600_000, state: "behind" };
const japan: PlanGoal = { id: "jp", name: "Japan trip", priority: 2, kind: "short", target_today_minor: 300_000, inflation_bp: null, return_bp: 0, target_date: "2027-10-14", value: 0, state: "behind" };
const subs = subscriptionFixedCosts([
  { expected_sgd_minor: 5_000, cycle: "monthly", status: "active", group_id: "lifestyle" },
  { expected_sgd_minor: 13_000, cycle: "yearly", status: "active", group_id: "lifestyle" },
]);
const base = (over: Partial<PlanInput> = {}): PlanInput => ({
  month: "2026-11", today: TODAY, income: 600_000, subscriptions: subs,
  essentials: [{ key: "rent", label: "Rent/Housing", amount: 200_000 }, { key: "groceries", label: "Groceries", amount: 60_000 }],
  lifestyleAverage: 200_000, goals: [japan, emergency], ...over,
});

describe("P: feasible plan", () => {
  it("fixed = subscriptions + annual set-asides + Essentials; goals = Σ required in priority order; Lifestyle = the rest, capped", () => {
    const p = buildPlan(base());
    expect(p.fixed.total).toBe(5_000 + 1_084 + 260_000);
    expect(p.fixed.lines.find((l) => l.key === "set_aside")!.amount).toBe(1_084); // annual set-aside included
    expect(p.goals.allocations.map((a) => [a.id, a.required])).toEqual([["ef", 50_000], ["jp", 25_000]]);
    expect(p.available).toBe(600_000 - 266_084 - 75_000);
    expect(p).toMatchObject({ feasible: true, floor: 120_000, cap: 220_000, lifestyle: 220_000, unallocated: 0, shortfall: 0, tradeOffs: [] });
  });
  it("the amount above the cap goes to goals in priority order", () => {
    const p = buildPlan(base());
    expect(p.goals.allocations[0]).toMatchObject({ id: "ef", extra: 38_916, total: 88_916 });
    expect(p.goals.allocations[1]).toMatchObject({ id: "jp", extra: 0 });
    // no goal left to absorb it → unallocated savings
    const rich = buildPlan(base({ income: 2_000_000 }));
    expect(rich.goals.allocations.map((a) => a.extra)).toEqual([550_000, 275_000]);
    expect(rich.unallocated).toBe(2_000_000 - 266_084 - 75_000 - 220_000 - 825_000);
  });
  it("line overrides (e.g. rent) replace the baseline line", () => {
    const p = buildPlan(base({ overrides: { rent: 250_000, gym: 8_000 } }));
    expect(p.fixed.lines.find((l) => l.key === "rent")).toMatchObject({ amount: 250_000, overridden: true });
    expect(p.fixed.total).toBe(266_084 + 50_000 + 8_000);
  });
  it("without Lifestyle history there is no floor and no cap", () => {
    const p = buildPlan(base({ lifestyleAverage: null }));
    expect(p).toMatchObject({ floor: 0, cap: null, feasible: true, lifestyle: 258_916 });
  });
  it("percentages add up to 100 (largest remainder)", () => {
    const p = buildPlan(base());
    expect(p.split).toEqual({ needs: 44, savings: 19, wants: 37 });
    expect(p.split.needs + p.split.savings + p.split.wants).toBe(100);
    expect(p.splitText).toBe("Your plan: 44 / 19 / 37 (needs / savings / wants)");
    for (const parts of [[1, 1, 1], [266_084, 113_916, 220_000], [5, 0, 0], [0, 0, 0], [999, 1, 1]]) {
      const pc = percentages(parts);
      expect(pc.reduce((a, b) => a + b, 0)).toBe(parts.some((x) => x > 0) ? 100 : 0);
    }
  });
});

describe("P: infeasible plan and trade-offs", () => {
  it("computes each trade-off", () => {
    const p = buildPlan(base({ income: 450_000, commissionHistory: [100_000, 50_000, 60_000] }));
    expect(p).toMatchObject({ feasible: false, available: 108_916, floor: 120_000, shortfall: 11_084, lifestyle: 108_916 });
    const extend = p.tradeOffs.find((t) => t.kind === "extend")!;
    expect(extend).toEqual({ kind: "extend", covers: true, changes: [{ id: "jp", name: "Japan trip", from: "2027-10-14", to: "2028-08-14", required: 13_637 }] });
    expect(p.tradeOffs.find((t) => t.kind === "lower_lifestyle")).toEqual({ kind: "lower_lifestyle", lifestyle: 108_916, weekly: 25_414 });
    expect(p.tradeOffs.find((t) => t.kind === "commission")).toEqual({ kind: "commission", shortfall: 11_084, commissionNeeded: 15_835, averageCommission: 70_000, covered: true });
  });
  it("the commission option needs at least 3 months of history", () => {
    const p = buildPlan(base({ income: 450_000, commissionHistory: [100_000, 50_000] }));
    expect(p.tradeOffs.map((t) => t.kind)).toEqual(["extend", "lower_lifestyle"]);
  });
  it("extending moves to the next goal up when the lowest one can't cover it (dated goals only)", () => {
    const mba: PlanGoal = { ...japan, id: "mba", name: "MBA", priority: 3, target_today_minor: 120_000, target_date: "2027-04-14" }; // 6 months → 20,000/mo
    const p = buildPlan(base({ income: 455_000, goals: [emergency, japan, mba] }));
    const ext = p.tradeOffs[0] as Extract<(typeof p.tradeOffs)[number], { kind: "extend" }>;
    expect(ext.changes.map((c) => c.id)).toEqual(["mba", "jp"]);
    expect(ext.covers).toBe(true);
    expect(ext.changes[0]).toMatchObject({ to: "2037-04-14" }); // MBA alone falls short even at +10 years
    expect(ext.changes[1]).toMatchObject({ to: "2028-03-14", required: 17_648 });
  });
});

describe("P: commission split", () => {
  it("70/20/10: behind goals first in priority order, buffer to the emergency fund while it has a gap", () => {
    const s = commissionSplit(100_000, DEFAULT_SPLIT, [
      { id: "ef", priority: 1, state: "on_track", kind: "emergency", gap: 20_000 },
      { id: "jp", priority: 2, state: "behind", kind: "short", gap: 10_000 },
      { id: "mba", priority: 3, state: "behind", kind: "mid", gap: 50_000 },
    ]);
    expect(s).toMatchObject({ goals: 70_000, fun: 20_000, buffer: 10_000, bonus: 20_000, unallocated: 0 });
    expect(s.pledges).toEqual([
      { goal_id: "jp", amount: 10_000, part: "goals" },
      { goal_id: "mba", amount: 50_000, part: "goals" },
      { goal_id: "ef", amount: 10_000, part: "goals" },
      { goal_id: "ef", amount: 10_000, part: "buffer" },
    ]);
  });
  it("full emergency fund: buffer goes to goals; nothing left to fill → unallocated", () => {
    const s = commissionSplit(10_001, DEFAULT_SPLIT, [{ id: "ef", priority: 1, state: "reached", kind: "emergency", gap: 0 }, { id: "jp", priority: 2, state: "behind", kind: "short", gap: 7_500 }]);
    expect(s.goals + s.fun + s.buffer).toBe(10_001);
    expect(s.pledges).toEqual([{ goal_id: "jp", amount: 7_001, part: "goals" }, { goal_id: "jp", amount: 499, part: "buffer" }]);
    expect(s.unallocated).toBe(10_001 - 2_000 - 7_500);
  });
});

describe("P: monthly check-in", () => {
  it("plan vs actual", () => {
    expect(planVsActual({ fixed: 266_084, goals: 113_916, lifestyle: 220_000 }, { fixed: 270_000, goals: 100_000, lifestyle: 205_000 })).toEqual([
      { key: "fixed", planned: 266_084, actual: 270_000, diff: 3_916 },
      { key: "goals", planned: 113_916, actual: 100_000, diff: -13_916 },
      { key: "lifestyle", planned: 220_000, actual: 205_000, diff: -15_000 },
    ]);
  });
});
