import { describe, expect, it } from "vitest";
import type { PlanOutput, TradeOff } from "@okanary/core";
import type { AcceptedPlan, IncomeEvent, PlanResponse } from "./api";
import {
  DEFAULT_SPLIT_PERCENTS, WIZARD_FLAG, splitPercentsTotal, splitRuleFromPercents, splitRuleText, splitRuleToPercents, acceptedText, applyOverrideEdits, budgetSourceNote, canAdvance, candidateLabel, capLine, capNote, commissionSplitText, commissionThisMonth, commissionTradeOffText,
  emergencyLine, eventLabel, extendChangeText, floorLine, goalAssumptionText, homePlanLine, infeasibleText, lifestyleText, nextStep, planMatchesAccepted, prevStep, proposedEvents,
  readWizardDone, referenceText, splitBarSegments, tradeOffCards, weeklyText, wizardShows, wizardStartStep, writeWizardDone,
} from "./plan";

const plan = (over: Partial<PlanOutput> = {}): PlanOutput => ({
  income: 500000, fixed: { lines: [], total: 220000 }, goals: { allocations: [], required: 95000, total: 95000 }, available: 185000, floor: 100000, cap: 185000,
  feasible: true, lifestyle: 185000, unallocated: 0, shortfall: 0, tradeOffs: [], split: { needs: 44, savings: 19, wants: 37 },
  splitText: "Your plan: 44 / 19 / 37 (needs / savings / wants)", references: [], ...over,
});

describe("split bar", () => {
  it("segments sum to 100% and carry the amounts", () => {
    const segs = splitBarSegments(plan());
    expect(segs.map((s) => s.key)).toEqual(["fixed", "goals", "lifestyle"]);
    expect(segs.reduce((a, s) => a + s.pct, 0)).toBe(100);
    expect(segs.map((s) => s.pct)).toEqual([44, 19, 37]);
    expect(segs.map((s) => s.amount)).toEqual([220000, 95000, 185000]);
  });
  it("includes unallocated savings and still sums to 100", () => {
    const segs = splitBarSegments(plan({ unallocated: 30000, lifestyle: 155000 }));
    expect(segs.map((s) => s.key)).toEqual(["fixed", "goals", "lifestyle", "unallocated"]);
    expect(segs.at(-1)!.label).toBe("Unallocated savings");
    expect(segs.reduce((a, s) => a + s.pct, 0)).toBe(100);
  });
  it("uses largest-remainder rounding for awkward shares", () => {
    const segs = splitBarSegments(plan({ fixed: { lines: [], total: 1 }, goals: { allocations: [], required: 1, total: 1 }, lifestyle: 1, unallocated: 0 }));
    expect(segs.map((s) => s.pct).sort()).toEqual([33, 33, 34]);
    expect(segs.reduce((a, s) => a + s.pct, 0)).toBe(100);
  });
  it("leaves out empty parts and an all-zero plan has no segments", () => {
    expect(splitBarSegments(plan({ lifestyle: 0, unallocated: 0 })).map((s) => s.key)).toEqual(["fixed", "goals"]);
    expect(splitBarSegments(plan({ fixed: { lines: [], total: 0 }, goals: { allocations: [], required: 0, total: 0 }, lifestyle: 0 }))).toEqual([]);
  });
  it("reads the references as context only", () => {
    expect(referenceText([{ name: "50/30/20" }, { name: "60/20/20 (Singapore)" }])).toBe("For reference: 50/30/20 · 60/20/20 (Singapore)");
  });
});

describe("amounts", () => {
  it("monthly with the weekly allowance it implies (days in month)", () => {
    // 31-day month: 310000 × 7 / 31 = 70000
    expect(weeklyText(310000, "2026-10")).toBe("≈ S$700/week");
    expect(lifestyleText(310000, "2026-10")).toBe("S$3,100/month (≈ S$700/week)");
    expect(acceptedText(310000, "2026-10")).toBe("Your Lifestyle budget is now S$3,100/month (≈ S$700/week)");
  });
  it("a cap note only when Lifestyle is held at the cap", () => {
    expect(capNote(plan({ available: 230000, cap: 185000 }), 10)).toBe("Capped at your usual + 10%; the rest goes to goals.");
    expect(capNote(plan({ available: 230000, cap: 185000, unallocated: 5000 }), 10)).toBe("Capped at your usual + 10%; the rest goes to goals. S$50.00 is left over once every goal is covered.");
    expect(capNote(plan({ available: 185000, cap: 185000 }), 10)).toBeNull();
    expect(capNote(plan({ available: 230000, cap: null }), 10)).toBeNull();
    expect(capNote(plan({ available: 230000, cap: 185000, feasible: false }), 10)).toBeNull();
  });
});

describe("commission", () => {
  const split = { goals: 70000, fun: 20000, buffer: 10000, unallocated: 0, bonus: 20000, pledges: [
    { goal_id: "g1", amount: 40000, part: "goals" as const }, { goal_id: "g2", amount: 30000, part: "goals" as const }, { goal_id: "ef", amount: 10000, part: "buffer" as const },
  ] };
  const names: Record<string, string> = { g1: "Japan", g2: "MBA", ef: "Emergency fund" };
  it("describes the split", () => {
    expect(commissionSplitText(split, (id) => names[id])).toBe("S$700 to goals: Japan S$400, MBA S$300 · S$200 guilt-free this week · S$100 buffer → Emergency fund");
  });
  it("falls back gracefully: unknown goal, no pledges, nothing to fill, zero parts", () => {
    expect(commissionSplitText(split, () => undefined)).toContain("a goal S$400");
    expect(commissionSplitText({ goals: 70000, fun: 20000, buffer: 10000, pledges: [], unallocated: 80000 }, () => undefined))
      .toBe("S$700 to goals · S$200 guilt-free this week · S$100 buffer · S$800 has no goal to fill yet");
    expect(commissionSplitText({ goals: 0, fun: 0, buffer: 5000, pledges: [], unallocated: 0 }, () => undefined)).toBe("S$50.00 buffer");
  });
  it("sums commission and bonus logged in the month only", () => {
    const ev = [
      { kind: "commission", amount_minor: 90000, received_on: "2026-10-03" }, { kind: "bonus", amount_minor: 10000, received_on: "2026-10-20" },
      { kind: "other", amount_minor: 5000, received_on: "2026-10-04" }, { kind: "commission", amount_minor: 70000, received_on: "2026-09-30" },
    ] as const;
    expect(commissionThisMonth([...ev], "2026-10")).toBe(100000);
    expect(commissionThisMonth([], "2026-10")).toBe(0);
  });
  it("lists proposed events with a split, and labels events and candidates", () => {
    const e = (id: string, split_status: IncomeEvent["split_status"], withSplit = true) => ({ id, kind: "commission", amount_minor: 90000, received_on: "2026-10-03", transaction_id: null, split_json: null, split_status, split: withSplit ? split : null }) as IncomeEvent;
    expect(proposedEvents([e("a", "proposed"), e("b", "confirmed"), e("c", "skipped"), e("d", "proposed", false)]).map((x) => x.id)).toEqual(["a"]);
    expect(eventLabel(e("a", "proposed"))).toBe("Commission S$900 · 3 Oct");
    expect(candidateLabel({ merchant: "ACME PTE LTD", occurred_at: "2026-09-28T04:00:00.000Z", amount_sgd_minor: 120000 })).toBe("Acme Pte Ltd · 28 Sep · S$1,200");
    expect(candidateLabel({ merchant: null, occurred_at: "2026-09-28T17:00:00.000Z", amount_sgd_minor: 5000 })).toBe("Income · 29 Sep · S$50.00"); // 01:00 SGT next day
  });
});

describe("trade-off cards", () => {
  const extend: TradeOff = { kind: "extend", covers: true, changes: [
    { id: "g1", name: "Japan trip", from: "2027-10-15", to: "2028-08-15", required: 30000 },
    { id: "g2", name: "MBA", from: null, to: "2031-01-01", required: 20000 },
  ] };
  const lower: TradeOff = { kind: "lower_lifestyle", lifestyle: 90000, weekly: 20323 };
  const commission: TradeOff = { kind: "commission", shortfall: 30000, commissionNeeded: 42858, averageCommission: 50000, covered: true };
  it("extend dates read 'name: Oct 2027 → Aug 2028'", () => {
    expect(extendChangeText(extend.kind === "extend" ? extend.changes[0]! : (null as never))).toBe("Japan trip: Oct 2027 → Aug 2028");
    const c = tradeOffCards([extend])[0]!;
    expect(c).toMatchObject({ kind: "extend", title: "Push back goals", canUse: true, note: null });
    expect(c.lines).toEqual(["Japan trip: Oct 2027 → Aug 2028", "MBA: no date → Jan 2031"]);
  });
  it("an extend that can't cover the gap says so, calmly; one with no changes is left out", () => {
    expect(tradeOffCards([{ ...extend, covers: false } as TradeOff])[0]!.note).toMatch(/little short/);
    expect(tradeOffCards([{ kind: "extend", changes: [], covers: false }])).toEqual([]);
  });
  it("lower Lifestyle shows the monthly amount and the weekly allowance", () => {
    expect(tradeOffCards([lower])[0]!.title).toBe("Lower Lifestyle to S$900/month (≈ S$203/week)");
  });
  it("commission coverage text, with and without coverage", () => {
    expect(commissionTradeOffText(commission.kind === "commission" ? commission : (null as never))).toBe("Behind goals need S$300/month; covered if commission averages ≥ S$428/month (now S$500). Your average already covers it.");
    expect(commissionTradeOffText({ shortfall: 30000, commissionNeeded: 42858, averageCommission: 10000, covered: false })).toBe("Behind goals need S$300/month; covered if commission averages ≥ S$428/month (now S$100).");
    expect(tradeOffCards([commission])[0]).toMatchObject({ kind: "commission", canUse: false });
  });
  it("keeps the engine's order and omits commission when absent", () => {
    expect(tradeOffCards([extend, lower]).map((c) => c.kind)).toEqual(["extend", "lower_lifestyle"]);
    expect(tradeOffCards([extend, lower, commission]).map((c) => c.kind)).toEqual(["extend", "lower_lifestyle", "commission"]);
  });
  it("the intro is calm and never negative-sounding", () => {
    expect(infeasibleText({ available: 60000, floor: 100000 })).toBe("Your fixed costs and goals leave S$600/month for Lifestyle, and a comfortable floor is S$1,000. It doesn't fit yet, but here are some options.");
    expect(infeasibleText({ available: -5000, floor: 100000 })).toContain("leave S$0.00/month");
  });
});

describe("budget source and Home", () => {
  it("manual shows both numbers; plan and none show nothing", () => {
    expect(budgetSourceNote("manual", 150000, 185000)).toBe("Your Lifestyle budget was set by hand (S$1,500); the plan suggests S$1,850");
    expect(budgetSourceNote("plan", 185000, 185000)).toBeNull();
    expect(budgetSourceNote("none", null, 185000)).toBeNull();
    expect(budgetSourceNote("manual", null, 185000)).toBeNull();
  });
  const accepted = (o: Partial<PlanOutput> = {}) => ({ id: "p", month: "2026-10", inputs: {}, outputs: plan(o), accepted: true, accepted_at: null }) as unknown as AcceptedPlan;
  const full = (acc: AcceptedPlan | null) => ({ month: "2026-10", plan: plan(), accepted: acc }) as unknown as PlanResponse;
  it("Home line appears only with an accepted plan for the month", () => {
    expect(homePlanLine(full(accepted()))).toBe("Plan: S$1,850/mo Lifestyle · S$950/mo to goals");
    expect(homePlanLine(full(null))).toBeNull();
    expect(homePlanLine({ month: "2026-10", needs_income: true })).toBeNull();
    expect(homePlanLine(undefined)).toBeNull();
  });
  it("knows when the accepted plan still matches", () => {
    expect(planMatchesAccepted(plan(), plan())).toBe(true);
    expect(planMatchesAccepted(plan(), plan({ lifestyle: 100000 }))).toBe(false);
    expect(planMatchesAccepted(plan(), plan({ goals: { allocations: [], required: 95000, total: 100000 } }))).toBe(false);
    expect(planMatchesAccepted(plan(), plan({ fixed: { lines: [], total: 1 } }))).toBe(false);
  });
});

describe("assumptions", () => {
  it("floor, cap, emergency and goal lines", () => {
    expect(floorLine({ floor: 100000 }, null, 60)).toBe("Lifestyle floor: 60% of your usual (S$1,000/month)");
    expect(floorLine({ floor: 0 }, null, 60)).toBe("Lifestyle floor: 60% of your usual (needs a few months of history)");
    expect(floorLine({ floor: 80000 }, 80000, 60)).toBe("Lifestyle floor: S$800/month (set by you)");
    expect(capLine({ cap: 185000 }, 10)).toBe("Lifestyle cap: your usual + 10% (S$1,850/month)");
    expect(capLine({ cap: null }, 10)).toContain("needs a few months of history");
    expect(emergencyLine(6)).toBe("Emergency fund: 6 months of Essentials");
    expect(goalAssumptionText({ name: "MBA", return_bp: 500, inflation_bp: 350 })).toBe("MBA: 5% a year return, 3.5% inflation");
    expect(goalAssumptionText({ name: "Emergency fund", return_bp: 200, inflation_bp: null })).toBe("Emergency fund: 2% a year return, no inflation adjustment");
  });
});

describe("fixed-cost overrides", () => {
  const lines = [{ key: "rent", amount: 180000 }, { key: "groceries", amount: 60000 }, { key: "Gym", amount: 9000 }];
  it("only changed amounts become overrides; existing ones stay", () => {
    expect(applyOverrideEdits({ Gym: 9000 }, lines, { rent: 200000, groceries: 60000, Gym: 9000 }, new Set(), [])).toEqual({ Gym: 9000, rent: 200000 });
  });
  it("reset drops an override; invalid edits are ignored; a reset wins over an edit", () => {
    expect(applyOverrideEdits({ rent: 200000, Gym: 9000 }, lines, { rent: 123, groceries: null, Gym: 12000 }, new Set(["rent"]), [])).toEqual({ Gym: 12000 });
  });
  it("adds new lines (trimmed, valid only)", () => {
    expect(applyOverrideEdits({}, [], {}, new Set(), [{ key: " Parking ", amount: 25000 }, { key: "", amount: 100 }, { key: "x", amount: null }])).toEqual({ Parking: 25000 });
  });
});

describe("wizard logic", () => {
  it("shows with no income, or on first open without any accepted plan", () => {
    expect(wizardShows({ needsIncome: true, hasAcceptedPlan: false, flagDone: false })).toBe(true);
    expect(wizardShows({ needsIncome: true, hasAcceptedPlan: false, flagDone: true })).toBe(true);
    expect(wizardShows({ needsIncome: false, hasAcceptedPlan: false, flagDone: false })).toBe(true);
    expect(wizardShows({ needsIncome: false, hasAcceptedPlan: false, flagDone: true })).toBe(false);
    expect(wizardShows({ needsIncome: false, hasAcceptedPlan: true, flagDone: false })).toBe(false);
    expect(wizardShows({ needsIncome: false, hasAcceptedPlan: true, flagDone: true })).toBe(false);
  });
  it("starts at take-home until there is an income, then at fixed costs", () => {
    expect(wizardStartStep({ needsIncome: true })).toBe(1);
    expect(wizardStartStep({ needsIncome: false })).toBe(2);
  });
  it("moves one step at a time within 1..5", () => {
    expect(nextStep(1)).toBe(2);
    expect(nextStep(5)).toBe(5);
    expect(prevStep(3)).toBe(2);
    expect(prevStep(1)).toBe(1);
  });
  it("Next needs a take-home only on step 1", () => {
    expect(canAdvance(1, { incomeSet: false })).toBe(false);
    expect(canAdvance(1, { incomeSet: true })).toBe(true);
    expect(canAdvance(2, { incomeSet: false })).toBe(true);
  });
  it("the local flag is safe when storage is missing or throws", () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    expect(readWizardDone(store)).toBe(false);
    writeWizardDone(store);
    expect(mem.get(WIZARD_FLAG)).toBe("1");
    expect(readWizardDone(store)).toBe(true);
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readWizardDone(blocked)).toBe(false);
    expect(() => writeWizardDone(blocked)).not.toThrow();
    expect(WIZARD_FLAG).toBe("okanary.planWizardDone");
  });
});

describe("commission split rule", () => {
  const rule = { goals_bp: 7000, fun_bp: 2000, buffer_bp: 1000 };
  it("reads the rule from basis points", () => {
    expect(splitRuleText(rule)).toBe("Commission split: 70% goals · 20% guilt-free · 10% buffer");
    expect(splitRuleText({ goals_bp: 3333, fun_bp: 3333, buffer_bp: 3334 })).toBe("Commission split: 33.33% goals · 33.33% guilt-free · 33.34% buffer");
    expect(splitRuleToPercents(rule)).toEqual({ goals: "70", fun: "20", buffer: "10" });
    expect(DEFAULT_SPLIT_PERCENTS).toEqual({ goals: "70", fun: "20", buffer: "10" });
  });
  it("percent inputs become basis points only when they are whole and add up to 100", () => {
    expect(splitRuleFromPercents({ goals: "60", fun: "30", buffer: "10" })).toEqual({ goals_bp: 6000, fun_bp: 3000, buffer_bp: 1000 });
    expect(splitRuleFromPercents({ goals: " 100 ", fun: "0", buffer: "0" })).toEqual({ goals_bp: 10000, fun_bp: 0, buffer_bp: 0 });
    expect(splitRuleFromPercents({ goals: "70", fun: "20", buffer: "5" })).toBeNull();
    expect(splitRuleFromPercents({ goals: "70", fun: "20", buffer: "15" })).toBeNull();
    expect(splitRuleFromPercents({ goals: "70.5", fun: "19.5", buffer: "10" })).toBeNull();
    expect(splitRuleFromPercents({ goals: "70", fun: "", buffer: "30" })).toBeNull();
    expect(splitRuleFromPercents({ goals: "abc", fun: "20", buffer: "10" })).toBeNull();
    expect(splitRuleFromPercents({ goals: "-10", fun: "60", buffer: "50" })).toBeNull();
    expect(splitRuleFromPercents({ goals: "150", fun: "-25", buffer: "-25" })).toBeNull();
  });
  it("shows a running total, counting blanks and invalid parts as 0", () => {
    expect(splitPercentsTotal({ goals: "70", fun: "20", buffer: "5" })).toBe(95);
    expect(splitPercentsTotal({ goals: "70", fun: "x", buffer: "" })).toBe(70);
    expect(splitPercentsTotal({ goals: "70", fun: "20", buffer: "10" })).toBe(100);
  });
});
