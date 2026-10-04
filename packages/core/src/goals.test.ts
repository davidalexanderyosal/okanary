import { describe, expect, it } from "vitest";
import { monthlyAverage, type UsualRow } from "./baseline";
import { sgtLocalToUtc } from "./dates";
import {
  contributionTotals, emergencyTarget, goalsSummaryLine, linkedMarket, fundingWarnings, goalPace, goalStatus, goalTarget, goalValue, horizonFor, inflateTarget, monthsBetween, monthsToReach,
  paceWindowStart, projectedValue, projectionRange, requiredMonthly, retirementTarget, saferFundingPrompt, underspendAmount, underspendGoal, waterfall,
  type FundingLink, type ValueLookup,
} from "./goals";

describe("G: required monthly (PMT)", () => {
  it("r = 0: (FV − PV)/n, rounded up to the cent, floored at 0", () => {
    expect(requiredMonthly(120_000, 0, 0, 12)).toBe(10_000);
    expect(requiredMonthly(120_000, 20_000, 0, 12)).toBe(8_334);
    expect(requiredMonthly(120_000, 130_000, 0, 12)).toBe(0);
    expect(requiredMonthly(120_000, 20_000, 0, 0)).toBe(100_000); // due now
  });
  it("r > 0 matches the closed form (6% p.a., 10 years, S$100,000)", () => {
    expect(requiredMonthly(10_000_000, 0, 600, 120)).toBe(61_549); // 61,548.52 → 61,549
    const pmt = requiredMonthly(10_000_000, 1_000_000, 600, 120);
    expect(projectedValue(1_000_000, pmt, 600, 120)).toBeGreaterThanOrEqual(10_000_000);
    expect(projectedValue(1_000_000, pmt - 1, 600, 120)).toBeLessThan(10_000_000);
  });
  it("projected value with growth (2% p.a., 12 months)", () => {
    expect(projectedValue(100_000, 10_000, 200, 12)).toBe(223_096);
    expect(projectedValue(100_000, 10_000, 0, 12)).toBe(220_000);
  });
});

describe("G: targets", () => {
  it("inflates a today's-dollars target: S$60,000 today ≈ S$69,556 in 5 years at 3%", () => {
    expect(inflateTarget(6_000_000, 300, 60)).toBe(6_955_644);
    expect(goalTarget({ kind: "mid", target_today_minor: 6_000_000, inflation_bp: 300, target_date: "2031-10-14" }, "2026-10-14")).toBe(6_955_644);
    expect(goalTarget({ kind: "mid", target_today_minor: 6_000_000, inflation_bp: null, target_date: "2031-10-14" }, "2026-10-14")).toBe(6_955_644); // default 3%
    expect(goalTarget({ kind: "short", target_today_minor: 300_000, inflation_bp: 300, target_date: "2027-06-01" }, "2026-10-14")).toBe(300_000);
  });
  it("retirement helper: monthly × 12 × 25", () => {
    expect(retirementTarget(400_000)).toBe(120_000_000);
  });
  it("emergency target = 6 × average monthly Essentials from actual spending", () => {
    const row = (date: string, amt: number, group = "essentials"): UsualRow => ({ occurred_at: sgtLocalToUtc(date, "12:00"), amount_sgd_minor: amt, status: "confirmed", is_excluded: 0, is_reimbursable: 0, is_refund: 0, group_counts_as_spend: 1, group_id: group, category_id: "x" });
    const rows = [row("2026-07-03", 200_000), row("2026-08-03", 220_000), row("2026-09-03", 240_000), row("2026-09-04", 99_999, "lifestyle"), row("2026-10-03", 999_999)];
    const avg = monthlyAverage(rows, "2026-10-14T04:00:00Z", (r) => r.group_id === "essentials", { maxMonths: 6 });
    expect(avg).toEqual({ average: 220_000, months: ["2026-09", "2026-08", "2026-07"] });
    expect(emergencyTarget(avg.average)).toBe(1_320_000);
    expect(emergencyTarget(null)).toBeNull();
  });
});

describe("G: projected completion and status", () => {
  it("completion date at the current pace; null beyond 50 years", () => {
    expect(monthsToReach(120_000, 0, 10_000, 0)).toBe(12);
    expect(monthsToReach(120_000, 130_000, 0, 0)).toBe(0);
    expect(monthsToReach(120_000, 0, 0, 0)).toBeNull();
    expect(monthsToReach(100_000_000, 0, 1_000, 0)).toBeNull();
    expect(goalStatus({ target: 120_000, value: 0, pace: 10_000, returnBp: 0, targetDate: "2027-10-14", today: "2026-10-14" }).completion).toBe("2027-10");
  });
  it("status thresholds: on track, ahead (≥5% over), behind (+S$X/month or finish later), reached", () => {
    const base = { target: 120_000, value: 0, returnBp: 0, targetDate: "2027-10-14", today: "2026-10-14" };
    expect(goalStatus({ ...base, pace: 10_000 }).state).toBe("on_track");
    expect(goalStatus({ ...base, pace: 10_400 }).state).toBe("on_track"); // 124,800: 4% over
    expect(goalStatus({ ...base, pace: 10_500 })).toMatchObject({ state: "ahead", surplus: 6_000 }); // 5% over
    const behind = goalStatus({ ...base, pace: 8_000 });
    expect(behind).toMatchObject({ state: "behind", required: 10_000, extraMonthly: 2_000, completion: "2028-01" });
    expect(goalStatus({ ...base, value: 120_000, pace: 0 }).state).toBe("reached");
    expect(goalStatus({ ...base, pace: 0 })).toMatchObject({ state: "behind", completion: null });
  });
  it("long goals get a range at −2 / base / +2 percentage points", () => {
    const r = projectionRange(1_000_000, 50_000, 600, 240);
    expect(r.conservative).toBe(projectedValue(1_000_000, 50_000, 400, 240));
    expect(r.optimistic).toBe(projectedValue(1_000_000, 50_000, 800, 240));
    expect(r.conservative).toBeLessThan(r.base);
    expect(r.base).toBeLessThan(r.optimistic);
    expect(projectionRange(0, 100, 100, 12).conservative).toBe(1_200); // never below 0%
  });
});

describe("G: funding from net worth", () => {
  const values: ValueLookup = { account: (id) => ({ dbs: 500_000, ibkr: 2_000_000 } as Record<string, number>)[id] ?? null, holding: (id) => ({ voo: 1_000_000, btc: 600_000 } as Record<string, number>)[id] ?? null };
  const link = (p: Partial<FundingLink>): FundingLink => ({ goal_id: "g", source_type: "holding", source_id: "voo", share_bp: null, earmark_minor: null, ...p });

  it("value from linked holdings at a share (100% VOO + 50% BTC); contributions don't double count", () => {
    const v = goalValue([link({}), link({ source_id: "btc", share_bp: 5000 })], values, 77_777);
    expect(v).toEqual({ value: 1_300_000, linked: 1_300_000, earmarked: 0, contributions: 77_777, countsContributions: false });
  });
  it("earmarks and contribution-only goals count transferred contributions", () => {
    expect(goalValue([link({ source_type: "earmark", source_id: "dbs", earmark_minor: 150_000 })], values, 8_000).value).toBe(158_000);
    expect(goalValue([], values, 8_000).value).toBe(8_000);
  });
  it("warns when earmarks exceed the balance or shares exceed 100%", () => {
    const links = [
      link({ goal_id: "a", source_type: "earmark", source_id: "dbs", earmark_minor: 300_000 }),
      link({ goal_id: "b", source_type: "earmark", source_id: "dbs", earmark_minor: 250_000 }),
      link({ goal_id: "a", source_id: "voo", share_bp: 6000 }),
      link({ goal_id: "b", source_id: "voo", share_bp: 5000 }),
      link({ goal_id: "c", source_id: "btc", share_bp: 10000 }),
    ];
    expect(fundingWarnings(links, values)).toEqual([
      { type: "share_over", source_type: "holding", source_id: "voo", total_bp: 11000 },
      { type: "earmark_over", account_id: "dbs", claimed: 550_000, balance: 500_000 },
    ]);
    expect(fundingWarnings(links.slice(0, 1), values)).toEqual([]);
  });
});

describe("G: pace and progress", () => {
  it("pace = net change over ~3 months minus market movement, per month", () => {
    expect(paceWindowStart("2026-10-14")).toBe("2026-07-14");
    expect(paceWindowStart("2026-05-31")).toBe("2026-02-28");
    expect(goalPace({ valueNow: 1_300_000, baseline: { date: "2026-07-14", value: 1_000_000 }, marketSinceBaseline: 150_000, today: "2026-10-14" })).toBe(50_000);
    expect(goalPace({ valueNow: 130_000, baseline: { date: "2026-09-14", value: 100_000 }, marketSinceBaseline: 0, today: "2026-10-14" })).toBe(30_000); // 1 month of history
    expect(goalPace({ valueNow: 1, baseline: null, marketSinceBaseline: 0, today: "2026-10-14" })).toBeNull();
  });
  it("progress counts transferred contributions only; pledged shown apart", () => {
    expect(contributionTotals([
      { amount_sgd_minor: 8_000, status: "transferred" }, { amount_sgd_minor: 12_000, status: "pledged" }, { amount_sgd_minor: 5_000, status: "skipped" }, { amount_sgd_minor: 2_000, status: "transferred" },
    ])).toEqual({ transferred: 10_000, pledged: 12_000, skipped: 5_000 });
    expect(goalValue([], { account: () => null, holding: () => null }, 10_000).value).toBe(10_000);
  });
});

describe("G: horizon re-classification", () => {
  it("short < 2y, mid 2–10y, long ≥ 10y, recalculated as time passes", () => {
    expect(monthsBetween("2026-10-14", "2028-10-13")).toBe(23);
    expect(horizonFor("2028-10-13", "2026-10-14")).toBe("short");
    expect(horizonFor("2028-10-14", "2026-10-14")).toBe("mid");
    expect(horizonFor("2036-10-14", "2026-10-14")).toBe("long");
    expect(horizonFor("2028-10-14", "2026-10-15")).toBe("short"); // a day later it crosses below 2 years
    expect(horizonFor(null, "2026-10-14", "emergency")).toBe("short");
    expect(horizonFor(null, "2026-10-14", "retirement")).toBe("long");
  });
  it("prompts 'Move to safer funding?' once when crossing below 2 years with stock/crypto funding", () => {
    expect(saferFundingPrompt("mid", "short", true)).toBe(true);
    expect(saferFundingPrompt("mid", "short", false)).toBe(false);
    expect(saferFundingPrompt("short", "short", true)).toBe(false);
    expect(saferFundingPrompt(null, "short", true)).toBe(false);
  });
});

describe("G: underspend pledges", () => {
  it("amount = max(0, allowance − Lifestyle spent)", () => {
    expect(underspendAmount(20_000, 12_000)).toBe(8_000);
    expect(underspendAmount(20_000, 25_000)).toBe(0);
  });
  it("goes to the marked goal, by default the highest-priority goal that is behind; none → no pledge", () => {
    const g = (id: string, priority: number, state: "behind" | "on_track", mark = 0, archived = 0) => ({ id, priority, state, receives_underspend: mark, archived });
    expect(underspendGoal([g("a", 1, "on_track"), g("b", 2, "behind", 1)])!.id).toBe("b");
    expect(underspendGoal([g("a", 3, "behind"), g("b", 2, "behind"), g("c", 1, "on_track")])!.id).toBe("b");
    expect(underspendGoal([g("a", 1, "on_track")])).toBeNull();
    expect(underspendGoal([g("a", 1, "behind", 1, 1)])).toBeNull();
    expect(underspendGoal([])).toBeNull();
  });
  it("waterfall fills goals in priority order", () => {
    expect(waterfall(100, [{ id: "b", priority: 2, need: 80 }, { id: "a", priority: 1, need: 50 }, { id: "c", priority: 3, need: 10 }])).toEqual({ allocations: [{ id: "a", amount: 50 }, { id: "b", amount: 50 }], left: 0 });
    expect(waterfall(100, [{ id: "a", priority: 1, need: 30 }])).toEqual({ allocations: [{ id: "a", amount: 30 }], left: 70 });
  });
});

describe("G: market on links and the Home line", () => {
  it("sums per-day market moves on linked accounts/holdings at their share; earmarks never move", () => {
    const days = [new Map([["holding:voo", 10_000], ["account:usd", 500], ["holding:btc", -4_000]]), new Map([["holding:voo", -2_000]])];
    const acctOf = (h: string) => ({ voo: "ibkr", btc: "cold" } as Record<string, string>)[h] ?? null;
    expect(linkedMarket([{ goal_id: "g", source_type: "holding", source_id: "voo", share_bp: 5000, earmark_minor: null }], days, acctOf)).toBe(4_000);
    expect(linkedMarket([{ goal_id: "g", source_type: "nw_account", source_id: "ibkr", share_bp: null, earmark_minor: null }], days, acctOf)).toBe(8_000);
    expect(linkedMarket([{ goal_id: "g", source_type: "earmark", source_id: "usd", share_bp: null, earmark_minor: 100 }], days, acctOf)).toBe(0);
  });
  it("Goals: 4 on track · 1 behind (MBA −S$120/mo)", () => {
    const g = (name: string, priority: number, state: "on_track" | "behind" | "ahead" | "reached", extraMonthly = 0) => ({ name, priority, status: { state, extraMonthly } });
    expect(goalsSummaryLine([g("EF", 1, "reached"), g("Japan", 2, "on_track"), g("MBA", 3, "behind", 12_000), g("Car", 4, "ahead"), g("Ret", 5, "on_track")])).toBe("Goals: 4 on track · 1 behind (MBA −S$120/mo)");
    expect(goalsSummaryLine([g("A", 2, "behind", 5_000), g("B", 1, "behind", 1_000)])).toBe("Goals: 0 on track · 2 behind (B −S$10/mo, …)");
    expect(goalsSummaryLine([])).toBeNull();
  });
});
