import { describe, expect, it } from "vitest";
import type { UsualResult } from "@okanary/core";
import { basedOnNote, monthUsualLine, usualDiffText, weekUsualText } from "./usual";

const r = (current: number, usual: number | null, state: UsualResult["comparison"]["state"], pct: number | null = null): UsualResult => ({
  current, usual, comparison: { state, diff: usual == null ? null : current - usual, pct },
});

describe("month line (Home)", () => {
  it("below usual: neutral", () => {
    expect(monthUsualLine(r(64000, 72727, "below", -12), 14, 3)).toEqual({ text: "S$640 so far · 12% below your usual by day 14", tone: "neutral" });
  });
  it("above usual: amber, never red", () => {
    expect(monthUsualLine(r(64000, 54237, "above", 18), 14, 3)).toEqual({ text: "S$640 so far · 18% above your usual by day 14", tone: "amber" });
  });
  it("about usual: neutral", () => {
    expect(monthUsualLine(r(64000, 63000, "about", 2), 14, 3)).toEqual({ text: "S$640 so far · about your usual by day 14", tone: "neutral" });
  });
  it("usual of 0 with spend this month: above, no percentage", () => {
    expect(monthUsualLine(r(5000, 0, "above", null), 14, 2)).toEqual({ text: "S$50.00 so far · above your usual by day 14 (based on 2 months)", tone: "amber" });
  });
  it("no history", () => {
    expect(monthUsualLine(r(5000, null, "no_history"), 14, 0)).toEqual({ text: "Not enough history yet", tone: "neutral" });
  });
  it("notes how many months it is based on when fewer than 3", () => {
    expect(basedOnNote(0)).toBe("");
    expect(basedOnNote(1)).toBe(" (based on 1 month)");
    expect(basedOnNote(2)).toBe(" (based on 2 months)");
    expect(basedOnNote(3)).toBe("");
    expect(monthUsualLine(r(64000, 72727, "below", -12), 9, 1).text).toBe("S$640 so far · 12% below your usual by day 9 (based on 1 month)");
  });
});

describe("week line (Lifestyle card)", () => {
  it("about / above / below", () => {
    expect(weekUsualText(r(10000, 10200, "about", -2))).toEqual({ text: "Week: about usual", tone: "neutral" });
    expect(weekUsualText(r(14000, 10000, "above", 40))).toEqual({ text: "Week: S$40.00 above usual", tone: "amber" });
    expect(weekUsualText(r(7500, 10000, "below", -25))).toEqual({ text: "Week: S$25.00 below usual", tone: "neutral" });
  });
  it("no history: no line", () => {
    expect(weekUsualText(r(14000, null, "no_history"))).toBeNull();
  });
});

describe("report row diff", () => {
  it("signs the change; only increases are amber", () => {
    expect(usualDiffText(r(14000, 10000, "above", 40))).toEqual({ text: "+S$40.00", tone: "amber" });
    expect(usualDiffText(r(0, 6667, "below", -100))).toEqual({ text: "−S$66.67", tone: "neutral" });
    expect(usualDiffText(r(10100, 10000, "about", 1))).toEqual({ text: "about usual", tone: "neutral" });
    expect(usualDiffText(r(100, null, "no_history"))).toEqual({ text: "–", tone: "neutral" });
  });
});
