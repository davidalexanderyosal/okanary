import { describe, expect, it } from "vitest";
import {
  addMonthsToDate, assumptionsText, behindText, bpToPercent, buildChartData, defaultReturnPercent, emergencySuggestionText, fundingSummary, groupByHorizon, inflatedText,
  monthYear, moveInGroup, percentToBp, pledgeLabel, pledgedText, plannedText, previewTarget, progressPct, requiredVsPaceText, retirementHelperText, statusChip, warningText,
} from "./goals";

describe("status chip", () => {
  it("reads Reached / On track / Ahead by S$X / Behind", () => {
    expect(statusChip({ state: "reached", surplus: 100 })).toEqual({ text: "Reached", tone: "good" });
    expect(statusChip({ state: "on_track", surplus: 100 })).toEqual({ text: "On track", tone: "good" });
    expect(statusChip({ state: "ahead", surplus: 250000 })).toEqual({ text: "Ahead by S$2,500", tone: "good" });
    expect(statusChip({ state: "behind", surplus: -9000 })).toEqual({ text: "Behind", tone: "amber" });
  });
});

describe("required vs pace", () => {
  it("shows both amounts", () => {
    expect(requiredVsPaceText(45000, 30000)).toBe("Needs S$450/mo · you're at S$300/mo");
  });
  it("says so when there is not enough history (null pace)", () => {
    expect(requiredVsPaceText(45000, null)).toBe("Needs S$450/mo · pace: not enough history yet");
  });
  it("a negative pace reads as S$0", () => {
    expect(requiredVsPaceText(45000, -2000)).toBe("Needs S$450/mo · you're at S$0.00/mo");
  });
  it("planned and pledged lines only appear when there is something to say", () => {
    expect(plannedText(30000)).toBe("Plan: S$300/mo");
    expect(plannedText(null)).toBeNull();
    expect(plannedText(0)).toBeNull();
    expect(pledgedText(12000)).toBe("S$120 pledged, not yet moved");
    expect(pledgedText(0)).toBeNull();
  });
});

describe("behind text", () => {
  it("gives the extra monthly amount and the finish month at the current pace", () => {
    expect(behindText({ state: "behind", extraMonthly: 12000, completion: "2028-01" })).toBe("+S$120/month to finish on time, or finish in Jan 2028 at current pace");
  });
  it("says not reached within 50 years when there is no completion", () => {
    expect(behindText({ state: "behind", extraMonthly: 12000, completion: null })).toBe("+S$120/month to finish on time, or not reached within 50 years at current pace");
  });
  it("is null for goals that are not behind", () => {
    expect(behindText({ state: "on_track", extraMonthly: 0, completion: "2027-05" })).toBeNull();
    expect(behindText({ state: "reached", extraMonthly: 0, completion: null })).toBeNull();
  });
  it("month names", () => {
    expect(monthYear("2028-01")).toBe("Jan 2028");
    expect(monthYear("2031-12-05")).toBe("Dec 2031");
  });
});

describe("progress", () => {
  it("is value / target, capped 0..100", () => {
    expect(progressPct(50000, 200000)).toBe(25);
    expect(progressPct(300000, 200000)).toBe(100);
    expect(progressPct(-5, 200000)).toBe(0);
    expect(progressPct(0, 0)).toBe(0);
  });
});

describe("funding summary", () => {
  const names = {
    account: (id: string) => ({ a1: "DBS savings", a2: "Tiger" })[id],
    holding: (id: string) => ({ h1: "VOO" })[id],
  };
  it("lists shares and earmarks", () => {
    expect(fundingSummary([
      { source_type: "holding", source_id: "h1", share_bp: 10000, earmark_minor: null },
      { source_type: "earmark", source_id: "a1", share_bp: null, earmark_minor: 150000 },
    ], names)).toBe("100% VOO · S$1,500 in DBS savings");
  });
  it("shows fractional shares of an account", () => {
    expect(fundingSummary([{ source_type: "nw_account", source_id: "a2", share_bp: 5050, earmark_minor: null }], names)).toBe("50.5% Tiger");
  });
  it("copes with removed items and with nothing linked", () => {
    expect(fundingSummary([{ source_type: "holding", source_id: "gone", share_bp: 2500, earmark_minor: null }], names)).toBe("25% an item that was removed");
    expect(fundingSummary([], names)).toBe("No funding linked: counts what you transfer");
  });
  it("warnings read calmly", () => {
    expect(warningText({ type: "share_over", source_type: "holding", source_id: "h1", total_bp: 12000 }, names)).toBe("Shares of VOO add up to 120%, above 100%. Worth a look.");
    expect(warningText({ type: "earmark_over", account_id: "a1", claimed: 200000, balance: 150000 }, names)).toBe("Goals claim S$2,000 of DBS savings, which holds S$1,500. Worth a look.");
  });
});

describe("today ≈ in YEAR", () => {
  it("shows both amounts", () => {
    expect(inflatedText(6000000, 6955600, "2031-06-30")).toBe("S$60,000 today ≈ S$69,556 in 2031");
  });
  it("is null with no date or no change", () => {
    expect(inflatedText(6000000, 6000000, "2031-06-30")).toBeNull();
    expect(inflatedText(6000000, 6955600, null)).toBeNull();
  });
  it("live preview inflates mid/long goals like the API and leaves short goals alone", () => {
    // 3% for 5 years: 60,000 × 1.03^5 = 69,556.44
    const mid = previewTarget({ kind: "mid", todayMinor: 6000000, inflationBp: 300, targetDate: "2031-10-04", today: "2026-10-04" });
    expect(mid.target).toBe(6955644);
    expect(mid.text).toBe("S$60,000 today ≈ S$69,556 in 2031");
    const short = previewTarget({ kind: "short", todayMinor: 6000000, inflationBp: 300, targetDate: "2028-10-04", today: "2026-10-04" });
    expect(short).toEqual({ target: 6000000, text: null });
  });
  it("uses the default 3% when inflation is left empty", () => {
    expect(previewTarget({ kind: "long", todayMinor: 100000, inflationBp: null, targetDate: "2036-10-04", today: "2026-10-04" }).target).toBe(134392);
  });
});

describe("grouping by horizon", () => {
  const goals = [
    { id: "a", horizon: "long" as const }, { id: "b", horizon: "short" as const }, { id: "c", horizon: "mid" as const },
    { id: "d", horizon: "short" as const }, { id: "e", horizon: "long" as const },
  ];
  it("orders groups short, mid, long and keeps priority order inside", () => {
    expect(groupByHorizon(goals).map((g) => [g.horizon, g.items.map((x) => x.id)])).toEqual([["short", ["b", "d"]], ["mid", ["c"]], ["long", ["a", "e"]]]);
  });
  it("drops empty groups", () => {
    expect(groupByHorizon([{ id: "x", horizon: "mid" as const }]).map((g) => g.horizon)).toEqual(["mid"]);
    expect(groupByHorizon([])).toEqual([]);
  });
  it("reorders within a group by swapping with the group's neighbour in the full order", () => {
    expect(moveInGroup(goals, "d", -1)).toEqual(["a", "d", "c", "b", "e"]);
    expect(moveInGroup(goals, "b", 1)).toEqual(["a", "d", "c", "b", "e"]);
    expect(moveInGroup(goals, "a", 1)).toEqual(["e", "b", "c", "d", "a"]);
    expect(moveInGroup(goals, "b", -1)).toBeNull();
    expect(moveInGroup(goals, "c", 1)).toBeNull();
    expect(moveInGroup(goals, "zzz", 1)).toBeNull();
  });
});

describe("percent <-> basis points", () => {
  it("parses percentages", () => {
    expect(percentToBp("4.5")).toBe(450);
    expect(percentToBp("4.5%")).toBe(450);
    expect(percentToBp(" 3 ")).toBe(300);
    expect(percentToBp("0")).toBe(0);
    expect(percentToBp("2.25")).toBe(225);
    expect(percentToBp("0.05")).toBe(5);
  });
  it("rejects anything invalid", () => {
    for (const bad of ["", "abc", "-1", "4.555", "4,5", "1e2", "."]) expect(percentToBp(bad)).toBeNull();
  });
  it("formats basis points back", () => {
    expect(bpToPercent(450)).toBe("4.5");
    expect(bpToPercent(600)).toBe("6");
    expect(bpToPercent(333)).toBe("3.33");
    expect(bpToPercent(5)).toBe("0.05");
    expect(bpToPercent(0)).toBe("0");
    expect(bpToPercent(10000)).toBe("100");
  });
  it("shows the default return for the horizon the date gives", () => {
    expect(defaultReturnPercent("short", "2027-06-01", "2026-10-04")).toBe("2");
    expect(defaultReturnPercent("mid", "2033-06-01", "2026-10-04")).toBe("4");
    expect(defaultReturnPercent("long", "2050-06-01", "2026-10-04")).toBe("6");
    expect(defaultReturnPercent("retirement", null, "2026-10-04")).toBe("6");
  });
  it("assumptions text", () => {
    expect(assumptionsText({ kind: "long", return_bp: 600, return_bp_is_default: true, inflation_bp: null, target_date: "2050-01-01" })).toBe("Return 6% p.a. (default) · Inflation 3% p.a.");
    expect(assumptionsText({ kind: "mid", return_bp: 450, return_bp_is_default: false, inflation_bp: 400, target_date: "2032-01-01" })).toBe("Return 4.5% p.a. · Inflation 4% p.a.");
    expect(assumptionsText({ kind: "short", return_bp: 200, return_bp_is_default: true, inflation_bp: 300, target_date: "2027-01-01" })).toBe("Return 2% p.a. (default)");
  });
});

describe("4% rule helper", () => {
  it("monthly × 12 × 25, labelled a rule of thumb", () => {
    expect(retirementHelperText(300000)).toBe("S$3,000/month × 12 × 25 = S$900,000: a rule of thumb (4% rule), edit it if you like");
  });
});

describe("pledges and suggestion text", () => {
  it("labels the source", () => {
    expect(pledgeLabel({ source: "underspend", period: "2026-W39" })).toBe("Last week's underspend (2026-W39)");
    expect(pledgeLabel({ source: "want_skipped", period: "2026-10" })).toBe("A want you skipped");
  });
  it("emergency suggestion", () => {
    expect(emergencySuggestionText(1200000, 4)).toBe("Suggested: emergency fund of S$12,000 (6 × your average Essentials, based on 4 months)");
    expect(emergencySuggestionText(1200000, 1)).toContain("based on 1 month)");
  });
});

describe("chart data", () => {
  it("adds months with the day clamped", () => {
    expect(addMonthsToDate("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsToDate("2026-11-15", 3)).toBe("2027-02-15");
  });
  it("joins history, today and the projected path (dollars)", () => {
    const rows = buildChartData({
      today: "2026-10-04", value: 50000, history: [{ date: "2026-09-04", value_sgd_minor: 40000 }, { date: "2026-10-04", value_sgd_minor: 50000 }],
      path: [50000, 60000, 70000], cone: null,
    });
    expect(rows.map((r) => [r.date, r.actual, r.projected])).toEqual([
      ["2026-09-04", 400, undefined], ["2026-10-04", 500, 500], ["2026-11-04", undefined, 600], ["2026-12-04", undefined, 700],
    ]);
  });
  it("thins long paths, keeps the last point and carries the cone", () => {
    const n = 600;
    const path = Array.from({ length: n + 1 }, (_, k) => k * 100);
    const rows = buildChartData({ today: "2026-10-04", value: 0, history: [], path, cone: { conservative: path.map((v) => v - 50), optimistic: path.map((v) => v + 50) }, maxPoints: 100 });
    expect(rows.length).toBeLessThanOrEqual(110);
    expect(rows[rows.length - 1]!.projected).toBe(n);
    expect(rows[rows.length - 1]!.band).toEqual([n - 0.5, n + 0.5]);
  });
});
