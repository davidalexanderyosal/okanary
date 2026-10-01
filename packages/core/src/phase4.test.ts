import { describe, expect, it } from "vitest";
import { addDays, cycleBounds, dueDateAfter, lastStatementDate, nextStatementDate } from "./cycle";
import { DEFAULT_THRESHOLDS, expectedByDay, paceFor, parseThresholds, resolveBudgets, safeToSpendToday, thresholdsReached } from "./pace";
import { billEstimate, summarizeMonth, type SummaryRow } from "./summary";

describe("pace", () => {
  it("expectedByDay is linear and integer", () => {
    expect(expectedByDay(90000, 14, 31)).toBe(40645); // floor(90000*14/31)
    expect(expectedByDay(90000, 31, 31)).toBe(90000);
    expect(expectedByDay(90000, 0, 31)).toBe(0);
    expect(expectedByDay(90000, 99, 31)).toBe(90000);
  });
  it("paceFor states", () => {
    const b = 90000;
    expect(paceFor(40645, b, 14, 31).state).toBe("on");
    expect(paceFor(30000, b, 14, 31).state).toBe("under");
    expect(paceFor(60000, b, 14, 31)).toMatchObject({ state: "over", delta: 60000 - 40645, pctSpent: 67, pctExpected: 45 });
    expect(paceFor(91000, b, 14, 31).state).toBe("exceeded");
  });
  it("safeToSpendToday = (budget - spent) / days left, floored, never negative", () => {
    // S$900 budget, S$642 spent, day 14 of 31 -> 18 days left including today
    expect(safeToSpendToday(90000, 64200, 18)).toEqual({ perDay: 1433, remaining: 25800, daysLeft: 18, exceeded: false });
    expect(safeToSpendToday(90000, 95000, 10)).toMatchObject({ perDay: 0, remaining: -5000, exceeded: true });
    expect(safeToSpendToday(90000, 0, 0).daysLeft).toBe(1);
  });
  it("thresholdsReached uses exact integer comparison", () => {
    expect(thresholdsReached(44999, 90000, [50, 80, 100])).toEqual([]);
    expect(thresholdsReached(45000, 90000, [50, 80, 100])).toEqual([50]);
    expect(thresholdsReached(71999, 90000, [50, 80, 100])).toEqual([50]);
    expect(thresholdsReached(72000, 90000, [50, 80, 100])).toEqual([50, 80]);
    expect(thresholdsReached(90000, 90000, [50, 80, 100])).toEqual([50, 80, 100]);
    expect(thresholdsReached(100, 0, [50])).toEqual([]);
  });
  it("parseThresholds", () => {
    expect(parseThresholds("80, 50,80")).toEqual([50, 80]);
    expect(parseThresholds("junk")).toEqual(DEFAULT_THRESHOLDS);
    expect(parseThresholds(null)).toEqual(DEFAULT_THRESHOLDS);
    expect(parseThresholds("0,500,75")).toEqual([75]);
  });
  it("resolveBudgets: latest effective_from <= month wins; 0 means none", () => {
    const rows = [
      { scope: "group" as const, ref_id: "lifestyle", monthly_amount_sgd_minor: 90000, effective_from: "2026-08" },
      { scope: "group" as const, ref_id: "lifestyle", monthly_amount_sgd_minor: 80000, effective_from: "2026-10" },
      { scope: "group" as const, ref_id: "essentials", monthly_amount_sgd_minor: 200000, effective_from: "2026-08" },
      { scope: "group" as const, ref_id: "essentials", monthly_amount_sgd_minor: 0, effective_from: "2026-10" },
      { scope: "category" as const, ref_id: "coffee", monthly_amount_sgd_minor: 5000, effective_from: "2026-11" },
    ];
    expect(resolveBudgets(rows, "2026-09").map((r) => [r.ref_id, r.monthly_amount_sgd_minor])).toEqual([["lifestyle", 90000], ["essentials", 200000]]);
    expect(resolveBudgets(rows, "2026-10").map((r) => [r.ref_id, r.monthly_amount_sgd_minor])).toEqual([["lifestyle", 80000]]);
    expect(resolveBudgets(rows, "2026-07")).toEqual([]);
  });
});

describe("card cycle dates", () => {
  it("last/next statement around the statement day", () => {
    expect(lastStatementDate(12, "2026-10-01")).toBe("2026-09-12");
    expect(nextStatementDate(12, "2026-10-01")).toBe("2026-10-12");
    expect(lastStatementDate(12, "2026-10-12")).toBe("2026-10-12"); // on the day: that statement is "last"
    expect(nextStatementDate(12, "2026-10-12")).toBe("2026-11-12");
    expect(lastStatementDate(12, "2026-10-20")).toBe("2026-10-12");
  });
  it("clamps day 31 to short months and wraps years", () => {
    expect(lastStatementDate(31, "2026-05-15")).toBe("2026-04-30");
    expect(nextStatementDate(31, "2026-02-10")).toBe("2026-02-28");
    expect(lastStatementDate(15, "2027-01-03")).toBe("2026-12-15");
    expect(nextStatementDate(15, "2026-12-20")).toBe("2027-01-15");
  });
  it("due date is the first due-day after the statement", () => {
    expect(dueDateAfter("2026-09-12", 7)).toBe("2026-10-07"); // "12 Sep statement, due 7 Oct"
    expect(dueDateAfter("2026-09-12", 28)).toBe("2026-09-28");
    expect(dueDateAfter("2026-12-20", 5)).toBe("2027-01-05");
  });
  it("addDays crosses month/year/leap boundaries", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("cycleBounds: spend on the statement day belongs to the closing cycle; the open cycle starts the next SGT day", () => {
    const b = cycleBounds(12, 7, "2026-10-01");
    expect(b).toMatchObject({ lastStatement: "2026-09-12", nextStatement: "2026-10-12", prevStatement: "2026-08-12", cycleStart: "2026-09-13", dueDate: "2026-10-07" });
    expect(b.current.start).toBe("2026-09-12T16:00:00.000Z"); // 13 Sep 00:00 SGT
    expect(b.current.end).toBe("2026-10-12T16:00:00.000Z"); // end of 12 Oct SGT
    expect(b.previous.start).toBe("2026-08-12T16:00:00.000Z");
    expect(b.previous.end).toBe("2026-09-12T16:00:00.000Z");
    expect(cycleBounds(12, null, "2026-10-01").dueDate).toBeNull();
  });
});

describe("summary extras for charts", () => {
  const base = { status: "confirmed" as const, is_excluded: 0, is_reimbursable: 0, is_refund: 0, amount_sgd_minor: 100, group_counts_as_spend: 1, occurred_at: "2026-10-05T04:00:00Z", category_id: "food", group_id: "lifestyle" };
  it("dailyByGroup and topMerchants follow the spend definition", () => {
    const rows: SummaryRow[] = [
      { ...base, amount_sgd_minor: 1000, merchant: "YA KUN" },
      { ...base, amount_sgd_minor: 500, merchant: "YA KUN", occurred_at: "2026-10-06T04:00:00Z" },
      { ...base, amount_sgd_minor: 3000, merchant: "NTUC", group_id: "essentials", category_id: "groceries" },
      { ...base, amount_sgd_minor: 9999, merchant: "VOIDED", status: "void" },
      { ...base, amount_sgd_minor: 7777, merchant: "CARD PAYMENT", group_id: "transfers", group_counts_as_spend: 0 },
    ];
    const s = summarizeMonth(rows, "2026-10", "2026-10-14T04:00:00Z");
    expect(s.dailyByGroup.lifestyle![4]).toBe(1000);
    expect(s.dailyByGroup.lifestyle![5]).toBe(500);
    expect(s.dailyByGroup.essentials![4]).toBe(3000);
    expect(s.topMerchants).toEqual([{ id: "NTUC", spent: 3000, count: 1 }, { id: "YA KUN", spent: 1500, count: 2 }]);
  });
});

describe("billEstimate (card bill != spend)", () => {
  const base = { status: "confirmed" as const, is_excluded: 0, is_reimbursable: 0, is_refund: 0, amount_sgd_minor: 1000, group_counts_as_spend: 1, occurred_at: "2026-10-05T04:00:00Z", category_id: "food", group_id: "lifestyle" };
  it("includes excluded/reimbursable/savings charges, nets refunds, skips void, transfers and income", () => {
    const rows: SummaryRow[] = [
      base,
      { ...base, amount_sgd_minor: 2000, is_reimbursable: 1 },
      { ...base, amount_sgd_minor: 500, is_excluded: 1 },
      { ...base, amount_sgd_minor: 300, is_refund: 1 },
      { ...base, amount_sgd_minor: 4000, group_id: "savings", group_counts_as_spend: 0 },
      { ...base, amount_sgd_minor: 9000, status: "void" },
      { ...base, amount_sgd_minor: 7000, group_id: "transfers", group_counts_as_spend: 0 },
      { ...base, amount_sgd_minor: 8000, group_id: "income", group_counts_as_spend: 0 },
    ];
    expect(billEstimate(rows)).toBe(1000 + 2000 + 500 - 300 + 4000);
  });
});
