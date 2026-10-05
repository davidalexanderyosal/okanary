import { describe, expect, it } from "vitest";
import { groupByKind, homeNetWorthLine, parseMoneyInput, parseQuantity, pricesAsOfText, refreshLimitedText, signedSgd, todayText, toAreaData, updatedAgoText } from "./networth";

describe("signed money", () => {
  it("uses + and a true minus, via sgd()", () => {
    expect(signedSgd(124000)).toBe("+S$1,240");
    expect(signedSgd(-34000)).toBe("−S$340");
    expect(signedSgd(0)).toBe("S$0.00");
    expect(signedSgd(-450)).toBe("−S$4.50");
  });
});

describe("Home line", () => {
  it("shows net worth and the month change", () => {
    expect(homeNetWorthLine(12345600, 124000)).toBe("Net worth S$123,456 · +S$1,240 this month");
  });
  it("a market fall reads as a plain negative", () => {
    expect(homeNetWorthLine(12345600, -34000)).toBe("Net worth S$123,456 · −S$340 this month");
  });
  it("omits the change when unknown", () => {
    expect(homeNetWorthLine(500000, null)).toBe("Net worth S$5,000");
    expect(homeNetWorthLine(500000, undefined)).toBe("Net worth S$5,000");
  });
});

describe("updated N days ago", () => {
  it("handles today, yesterday, N and unknown", () => {
    expect(updatedAgoText(0)).toBe("updated today");
    expect(updatedAgoText(-2)).toBe("updated today");
    expect(updatedAgoText(1)).toBe("updated yesterday");
    expect(updatedAgoText(12)).toBe("updated 12 days ago");
    expect(updatedAgoText(null)).toBe("no balance yet");
  });
});

describe("refresh limit toast", () => {
  it("rounds up to whole minutes, at least 1", () => {
    expect(refreshLimitedText(200)).toBe("Prices refresh at most every 5 minutes. Try again in 4 min.");
    expect(refreshLimitedText(300)).toBe("Prices refresh at most every 5 minutes. Try again in 5 min.");
    expect(refreshLimitedText(5)).toBe("Prices refresh at most every 5 minutes. Try again in 1 min.");
  });
});

describe("prices as of / today", () => {
  it("formats the last refresh in SGT", () => {
    expect(pricesAsOfText("2026-10-03T22:30:00.000Z")).toBe("Prices as of 06:30");
    expect(pricesAsOfText(null)).toBeNull();
  });
  it("labels the daily move", () => {
    expect(todayText({ change: 12000, flows: 0, market: 12000 })).toBe("Today: +S$120 · market");
    expect(todayText({ change: -12000, flows: 0, market: -12000 })).toBe("Today: −S$120 · market");
  });
});

describe("area chart data", () => {
  const rows = [
    { date: "2026-09-01", net: 1000000, classes: { cash: 800000, stocks: 300000, crypto: 50000, other: 0, liabilities: 150000 } },
    { date: "2026-09-02", net: 1100000, classes: { cash: 800000, stocks: 400000, crypto: 50000, other: 0, liabilities: 0 } },
  ];
  it("turns minor units into dollars with liabilities negative", () => {
    const d = toAreaData(rows);
    expect(d[0]).toEqual({ date: "2026-09-01", cash: 8000, stocks: 3000, crypto: 500, other: 0, liabilities: -1500, net: 10000 });
    expect(d[1]!.liabilities).toBe(0);
  });
  it("does not mutate the source (stays in minor units)", () => {
    toAreaData(rows);
    expect(rows[0]!.classes.cash).toBe(800000);
  });
});

describe("grouping and input parsing", () => {
  it("groups accounts by kind in order and drops empty groups", () => {
    const g = groupByKind([{ kind: "liability" as const, n: 1 }, { kind: "cash" as const, n: 2 }, { kind: "cash" as const, n: 3 }]);
    expect(g.map((x) => [x.kind, x.items.length])).toEqual([["cash", 2], ["liability", 1]]);
  });
  it("quantity stays a decimal string", () => {
    expect(parseQuantity("0.05000000")).toBe("0.05");
    expect(parseQuantity(" 12 ")).toBe("12");
    expect(parseQuantity("0")).toBeNull();
    expect(parseQuantity("-1")).toBeNull();
    expect(parseQuantity("1e3")).toBeNull();
    expect(parseQuantity("abc")).toBeNull();
    expect(parseQuantity("")).toBeNull();
  });
  it("money input goes through parseMajorToMinor", () => {
    expect(parseMoneyInput("1,234.50", "SGD")).toBe(123450);
    expect(parseMoneyInput("5000", "JPY")).toBe(5000);
    expect(parseMoneyInput("", "SGD")).toBeNull();
    expect(parseMoneyInput("x", "SGD")).toBeNull();
    expect(parseMoneyInput("-5", "SGD")).toBeNull();
    expect(parseMoneyInput("-5", "SGD", true)).toBe(-500);
  });
});
