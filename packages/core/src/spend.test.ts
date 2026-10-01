import { describe, expect, it } from "vitest";
import { isSpend, signedSgdMinor, spendAmount, sumSpend, type SpendRow } from "./spend";
import { summarizeMonth, UNCATEGORISED, type SummaryRow } from "./summary";

const base: SpendRow = { status: "confirmed", is_excluded: 0, is_reimbursable: 0, is_refund: 0, amount_sgd_minor: 1000, group_counts_as_spend: 1 };

describe("spend definition", () => {
  it("counts a normal confirmed purchase", () => expect(spendAmount(base)).toBe(1000));
  it("counts pending and needs_review", () => {
    expect(isSpend({ ...base, status: "pending" })).toBe(true);
    expect(isSpend({ ...base, status: "needs_review" })).toBe(true);
  });
  it("excludes void, excluded, reimbursable", () => {
    expect(isSpend({ ...base, status: "void" })).toBe(false);
    expect(isSpend({ ...base, is_excluded: 1 })).toBe(false);
    expect(isSpend({ ...base, is_reimbursable: 1 })).toBe(false);
  });
  it("excludes groups that don't count as spend (Transfers, Income, Savings)", () => {
    expect(isSpend({ ...base, group_counts_as_spend: 0 })).toBe(false);
  });
  it("uncategorised counts (D-02)", () => {
    expect(isSpend({ ...base, group_counts_as_spend: null })).toBe(true);
  });
  it("refunds are negative", () => {
    expect(signedSgdMinor({ is_refund: 1, amount_sgd_minor: 500 })).toBe(-500);
    expect(spendAmount({ ...base, is_refund: 1, amount_sgd_minor: 500 })).toBe(-500);
  });
  it("sumSpend nets refunds and skips non-spend", () => {
    const rows: SpendRow[] = [base, { ...base, amount_sgd_minor: 250 }, { ...base, is_refund: 1, amount_sgd_minor: 300 }, { ...base, is_excluded: 1 }, { ...base, status: "void" }];
    expect(sumSpend(rows)).toBe(1000 + 250 - 300);
  });
});

const row = (o: Partial<SummaryRow>): SummaryRow => ({ ...base, occurred_at: "2026-10-05T04:00:00Z", category_id: "food", group_id: "lifestyle", ...o });

describe("summarizeMonth", () => {
  const now = "2026-10-14T04:00:00Z"; // 12:00 SGT, day 14
  it("buckets by group/category and uses SGT months", () => {
    const rows = [
      row({ amount_sgd_minor: 1450, category_id: "coffee" }),
      row({ amount_sgd_minor: 5000, group_id: "essentials", category_id: "groceries" }),
      row({ amount_sgd_minor: 9999, group_id: "transfers", group_counts_as_spend: 0, category_id: "card_payment" }),
      row({ amount_sgd_minor: 700, category_id: null, group_id: null, group_counts_as_spend: null }),
      // 23:30 SGT on Sep 30 -> September, NOT October
      row({ occurred_at: "2026-09-30T15:30:00Z", amount_sgd_minor: 111111 }),
      // 00:30 SGT Oct 1 -> October though UTC is Sep 30
      row({ occurred_at: "2026-09-30T16:30:00Z", amount_sgd_minor: 200 }),
    ];
    const s = summarizeMonth(rows, "2026-10", now);
    expect(s.total).toBe(1450 + 5000 + 700 + 200);
    expect(s.byGroup.find((g) => g.id === "lifestyle")!.spent).toBe(1450 + 200);
    expect(s.byGroup.find((g) => g.id === "essentials")!.spent).toBe(5000);
    expect(s.byGroup.find((g) => g.id === UNCATEGORISED)!.spent).toBe(700);
    expect(s.byGroup.find((g) => g.id === "transfers")).toBeUndefined();
    expect(s.daily[0]).toBe(200);
    expect(s.daily[4]).toBe(1450 + 5000 + 700);
    expect(s.day).toBe(14);
    expect(s.daysInMonth).toBe(31);
  });
  it("reports non-spend groups separately and never in the total", () => {
    const rows = [row({ amount_sgd_minor: 20000, group_id: "savings", category_id: "savings", group_counts_as_spend: 0 }), row({ amount_sgd_minor: 100 })];
    const s = summarizeMonth(rows, "2026-10", now);
    expect(s.total).toBe(100);
    expect(s.byGroupNonSpend).toEqual([{ id: "savings", spent: 20000, count: 1 }]);
  });
  it("compares to the same day last month", () => {
    const rows = [
      row({ occurred_at: "2026-09-10T04:00:00Z", amount_sgd_minor: 1000 }), // inside Sep 1..14
      row({ occurred_at: "2026-09-20T04:00:00Z", amount_sgd_minor: 9000 }), // after day 14 -> not in MTD comparison
      row({ amount_sgd_minor: 400 }),
    ];
    const s = summarizeMonth(rows, "2026-10", now);
    expect(s.total).toBe(400);
    expect(s.totalLastMonthToDate).toBe(1000);
  });
});
