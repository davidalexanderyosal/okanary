import { describe, expect, it } from "vitest";
import { monthLine, nextResetDay, safeNote, weekHeadline } from "./allowance";
import { sgd } from "./format";

describe("weekly allowance text", () => {
  it("resets Mon for a Monday week ending Sun 2026-10-18", () => {
    expect(nextResetDay("2026-10-18")).toBe("Mon");
  });
  it("resets Sun for a Sunday week start (week ends Sat 2026-10-17)", () => {
    expect(nextResetDay("2026-10-17")).toBe("Sun");
  });
  it("wraps Saturday to Sunday and Sunday to Monday", () => {
    expect(nextResetDay("2026-10-24")).toBe("Sun");
    expect(nextResetDay("2026-10-25")).toBe("Mon");
  });
  it("says what is left of the allowance", () => {
    expect(weekHeadline({ total: 20323, spent: 4500, endDate: "2026-10-18" })).toBe(`This week: ${sgd(15823)} left of ${sgd(20323)} · resets Mon`);
    expect(weekHeadline({ total: 20323, spent: 4500, endDate: "2026-10-18" })).toBe("This week: S$158 left of S$203 · resets Mon");
  });
  it("shows exactly zero left (not over) when spend equals the allowance", () => {
    expect(weekHeadline({ total: 10000, spent: 10000, endDate: "2026-10-18" })).toBe("This week: S$0.00 left of S$100 · resets Mon");
  });
  it("uses neutral 'over' wording when spent exceeds the allowance", () => {
    const t = weekHeadline({ total: 20000, spent: 23050, endDate: "2026-10-17" });
    expect(t).toBe(`This week: ${sgd(3050)} over · resets Sun`);
    expect(t).toBe("This week: S$30.50 over · resets Sun");
  });
  it("month line with and without a budget", () => {
    expect(monthLine({ budget: 90000, spent: 64200 })).toBe("Month: S$642 / S$900");
    expect(monthLine({ budget: null, spent: 64200 })).toBe("Month: S$642");
  });
  it("safe-to-spend note", () => {
    expect(safeNote({ left: 15000, daysLeft: 4 })).toBe("S$150 over 4 days");
    expect(safeNote({ left: 500, daysLeft: 1 })).toBe("S$5.00 over 1 day");
    expect(safeNote({ left: -300, daysLeft: 2 })).toBe("S$0.00 over 2 days");
  });
});
