import { describe, expect, it } from "vitest";
import { allowanceParts, carryChainStarts, carryIn, proratePart, weekAllowance, weekSafeToSpend } from "./allowance";
import { daysInMonth, isoWeekLabel, parseWeekStart, sgtWeek, shiftWeek, weekStartDate } from "./dates";
import { inQuietHours, nudgeDecision, parseNudgeLimit, parseQuietHours, quietEndsAt, DEFAULT_QUIET } from "./nudge-gate";
import { purchaseNudgeBody } from "./nudge";

const flat = (b: number) => () => b;

describe("A: proration", () => {
  it("31-day month: 7 days of S$900 ≈ S$203.23, within one cent of exact", () => {
    const [p] = allowanceParts("2026-10-05", flat(90000));
    expect(p).toMatchObject({ month: "2026-10", fromDay: 5, toDay: 11, days: 7, daysInMonth: 31 });
    expect(Math.abs(p!.amount - (90000 * 7) / 31)).toBeLessThanOrEqual(1);
    expect(p!.amount).toBe(20322);
  });
  it("30-day month: exact 7/30", () => {
    expect(weekAllowance({ startDate: "2026-09-07", budgetForMonth: flat(90000) }).total).toBe(21000);
  });
  it("28-day month: exactly a quarter", () => {
    expect(daysInMonth("2026-02")).toBe(28);
    expect(weekAllowance({ startDate: "2026-02-02", budgetForMonth: flat(90000) }).total).toBe(22500);
  });
  it("week crossing a month uses each month's own budget for its own days", () => {
    const budgets: Record<string, number> = { "2026-09": 60000, "2026-10": 90000 };
    const a = weekAllowance({ startDate: "2026-09-28", budgetForMonth: (m) => budgets[m] });
    expect(a.parts.map((p) => [p.month, p.days, p.amount])).toEqual([["2026-09", 3, 6000], ["2026-10", 4, 11613]]);
    expect(a.total).toBe(17613);
  });
  it("week crossing a year boundary", () => {
    const a = weekAllowance({ startDate: "2026-12-28", budgetForMonth: (m) => (m === "2026-12" ? 62000 : 31000) });
    expect(a.parts.map((p) => [p.month, p.fromDay, p.toDay])).toEqual([["2026-12", 28, 31], ["2027-01", 1, 3]]);
    expect(a.parts[0]!.amount).toBe(8000); // 4/31 of 620.00
    expect(a.parts[1]!.amount).toBe(3000); // 3/31 of 310.00
    expect(a.total).toBe(11000);
  });
  it("sum check: the parts of every week touching a month add up to exactly that month's budget", () => {
    for (const month of ["2026-01", "2026-02", "2026-04", "2026-10", "2028-02", "2026-12"]) {
      for (const budget of [90000, 99999, 1, 0, 123457]) {
        for (const ws of [0, 1, 3, 6]) {
          let start = weekStartDate(`${month}-01`, ws);
          let sum = 0;
          while (start <= `${month}-${String(daysInMonth(month)).padStart(2, "0")}`) {
            for (const p of allowanceParts(start, flat(budget))) if (p.month === month) sum += p.amount;
            start = shiftWeek(start, 1);
          }
          expect(sum, `${month} ${budget} ws=${ws}`).toBe(budget);
        }
      }
    }
  });
  it("each part stays within one minor unit of the exact pro-rata value", () => {
    for (let a = 1; a <= 31; a++) for (let b = a; b <= 31; b++) {
      const v = proratePart(99999, a, b, 31);
      expect(Math.abs(v - (99999 * (b - a + 1)) / 31)).toBeLessThan(1);
    }
  });
});

describe("A: SGT week boundaries", () => {
  it("a purchase at Sunday 23:59 SGT belongs to that week; Monday 00:00 starts the next", () => {
    const sun = sgtWeek("2026-10-11T15:59:00Z"); // Sun 11 Oct 23:59 SGT
    expect(sun.startDate).toBe("2026-10-05");
    expect(sun.day).toBe(7);
    expect(sun.daysLeft).toBe(1);
    expect("2026-10-11T15:59:59.999Z" < sun.end).toBe(true);
    expect(sun.end).toBe("2026-10-11T16:00:00.000Z");
    const mon = sgtWeek("2026-10-11T16:00:00Z"); // Mon 12 Oct 00:00 SGT
    expect(mon.startDate).toBe("2026-10-12");
    expect(mon.start).toBe("2026-10-11T16:00:00.000Z");
    expect(mon.daysLeft).toBe(7);
  });
  it("week start day is configurable (Sunday)", () => {
    expect(sgtWeek("2026-10-11T04:00:00Z", 0).startDate).toBe("2026-10-11");
    expect(weekStartDate("2026-10-10", 0)).toBe("2026-10-04");
    expect(parseWeekStart("0")).toBe(0);
    expect(parseWeekStart(null)).toBe(1);
    expect(parseWeekStart("9")).toBe(1);
  });
  it("ISO week labels, including year ends", () => {
    expect(isoWeekLabel("2026-10-05")).toBe("2026-W41");
    expect(isoWeekLabel("2026-12-28")).toBe("2026-W53");
    expect(isoWeekLabel("2027-01-04")).toBe("2027-W01");
    expect(isoWeekLabel("2021-01-03")).toBe("2020-W53");
    expect(sgtWeek("2026-12-31T20:00:00Z").label).toBe("2026-W53"); // Fri 1 Jan 04:00 SGT is still in the week of 28 Dec
  });
});

describe("A: override, carry-over, safe to spend", () => {
  it("manual override replaces the derived value, even without a budget", () => {
    const a = weekAllowance({ startDate: "2026-10-05", budgetForMonth: flat(90000), overrideMinor: 15000 });
    expect(a).toMatchObject({ derived: 20322, base: 15000, overridden: true, total: 15000, hasAllowance: true });
    expect(weekAllowance({ startDate: "2026-10-05", budgetForMonth: () => null }).hasAllowance).toBe(false);
    expect(weekAllowance({ startDate: "2026-10-05", budgetForMonth: () => null, overrideMinor: 10000 }).hasAllowance).toBe(true);
  });
  it("carry-over chains only weeks that start in the same month", () => {
    expect(carryChainStarts("2026-10-19")).toEqual(["2026-10-05", "2026-10-12"]); // 28 Sep starts in September
    expect(carryChainStarts("2026-10-05")).toEqual([]);
    const prior = [
      { startDate: "2026-10-05", allowance: 20000, spent: 15000 }, // 50 under
      { startDate: "2026-10-12", allowance: 20000, spent: 23000 }, // 30 over
      { startDate: "2026-09-28", allowance: 20000, spent: 0 }, // other month: ignored
    ];
    const carry = carryIn("2026-10-19", prior);
    expect(carry).toBe(2000);
    const on = weekAllowance({ startDate: "2026-10-19", budgetForMonth: flat(90000), carry });
    const off = weekAllowance({ startDate: "2026-10-19", budgetForMonth: flat(90000) });
    expect(on.total - off.total).toBe(2000);
    expect(off.carry).toBe(0);
  });
  it("bonus (guilt-free share) is added on top", () => {
    expect(weekAllowance({ startDate: "2026-09-07", budgetForMonth: flat(90000), bonus: 5000 }).total).toBe(26000);
  });
  it("safe to spend today = (allowance − spent) ÷ days left including today, floored at 0", () => {
    expect(weekSafeToSpend(20000, 5000, 3)).toEqual({ perDay: 5000, left: 15000, daysLeft: 3, over: false });
    expect(weekSafeToSpend(20000, 5000, 7).perDay).toBe(2142);
    expect(weekSafeToSpend(20000, 25000, 2)).toEqual({ perDay: 0, left: -5000, daysLeft: 2, over: true });
    expect(weekSafeToSpend(20000, 20000, 1).perDay).toBe(0);
  });
});

describe("A: post-purchase push uses the week", () => {
  it("shows what is left this week", () => {
    expect(purchaseNudgeBody({ amountMinor: 1450, currency: "SGD", merchant: "Ya Kun", categoryName: "Coffee", lifestyleSpentSgd: 64200, day: 14, daysInMonth: 31, weekLeftSgd: 9600 }))
      .toBe("S$14.50 · Ya Kun · Coffee — S$96 left this week");
    expect(purchaseNudgeBody({ amountMinor: 1450, currency: "SGD", merchant: "Ya Kun", categoryName: "Coffee", lifestyleSpentSgd: 64200, day: 14, daysInMonth: 31, weekLeftSgd: -1200 }))
      .toBe("S$14.50 · Ya Kun · Coffee — S$12 over this week's allowance");
  });
  it("falls back to the month line without an allowance", () => {
    expect(purchaseNudgeBody({ amountMinor: 1450, currency: "SGD", merchant: "Ya Kun", categoryName: "Coffee", lifestyleSpentSgd: 64200, lifestyleBudgetSgd: 90000, day: 14, daysInMonth: 31 }))
      .toBe("S$14.50 · Ya Kun · Coffee — Lifestyle S$642 / S$900 (day 14/31)");
  });
});

describe("nudge gate (notification limit + quiet hours)", () => {
  it("holds during quiet hours until 08:00 SGT", () => {
    expect(inQuietHours("2026-10-14T15:30:00Z", DEFAULT_QUIET)).toBe(true); // 23:30 SGT
    expect(nudgeDecision("2026-10-14T15:30:00Z", 0, 2, DEFAULT_QUIET)).toEqual({ action: "hold", reason: "quiet", until: "2026-10-15T00:00:00.000Z" });
    expect(nudgeDecision("2026-10-14T23:59:00Z", 0, 2, DEFAULT_QUIET)).toEqual({ action: "hold", reason: "quiet", until: "2026-10-15T00:00:00.000Z" }); // 07:59 SGT
    expect(inQuietHours("2026-10-15T00:00:00Z", DEFAULT_QUIET)).toBe(false); // 08:00 SGT
    expect(quietEndsAt("2026-10-14T17:00:00Z", DEFAULT_QUIET)).toBe("2026-10-15T00:00:00.000Z"); // 01:00 SGT
  });
  it("allows at most `limit` per SGT day, then defers to the next day's 08:00", () => {
    const noon = "2026-10-14T04:00:00Z";
    expect(nudgeDecision(noon, 0, 2, DEFAULT_QUIET)).toEqual({ action: "send" });
    expect(nudgeDecision(noon, 1, 2, DEFAULT_QUIET)).toEqual({ action: "send" });
    expect(nudgeDecision(noon, 2, 2, DEFAULT_QUIET)).toEqual({ action: "hold", reason: "limit", until: "2026-10-15T00:00:00.000Z" });
  });
  it("settings parse with safe fallbacks; equal start/end disables quiet hours", () => {
    const none = parseQuietHours("00:00", "00:00");
    expect(inQuietHours("2026-10-14T15:30:00Z", none)).toBe(false);
    expect(nudgeDecision("2026-10-14T04:00:00Z", 5, 5, none)).toEqual({ action: "hold", reason: "limit", until: "2026-10-14T16:00:00.000Z" });
    expect(parseQuietHours("25:00", "08:00")).toEqual(DEFAULT_QUIET);
    expect(parseQuietHours("22:30", "07:00")).toEqual({ start: 1350, end: 420 });
    expect(parseNudgeLimit(null)).toBe(2);
    expect(parseNudgeLimit("0")).toBe(0);
    expect(parseNudgeLimit("abc")).toBe(2);
  });
});
