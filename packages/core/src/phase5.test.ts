import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "./csv";
import { addOneMonth, detectMonthly, type RecurringTxn } from "./recurring";
import { reconcile, type ExistingTxn } from "./reconcile";
import { looksLikePayment, parseStatement, parseStatementAmount, parseStatementDate } from "./statement";
import { isSpend, sumSpend, type SpendRow } from "./spend";
import { summarizeMonth, tripTotals, type SummaryRow } from "./summary";
import { weeklyDigestBody } from "./nudge";

const NOW = "2026-10-14T04:00:00Z";

describe("recurring detection", () => {
  const t = (merchant: string, date: string, amt: number, cat: string | null = "subscriptions"): RecurringTxn => ({ merchant, occurred_at: `${date}T04:00:00Z`, amount_sgd_minor: amt, category_id: cat });
  it("finds a monthly subscription (3+ charges, ~30-day gaps, similar amounts)", () => {
    const c = detectMonthly([t("NETFLIX", "2026-07-12", 1998), t("NETFLIX", "2026-08-12", 1998), t("NETFLIX", "2026-09-12", 2098)], NOW);
    expect(c).toEqual([{ merchant: "NETFLIX", expected_amount_sgd_minor: 1998, cadence: "monthly", occurrences: 3, last_date: "2026-09-12", next_expected: "2026-10-12", category_id: "subscriptions" }]);
  });
  it("needs three charges; two isn't a pattern", () => expect(detectMonthly([t("X", "2026-08-12", 1000), t("X", "2026-09-12", 1000)], NOW)).toEqual([]));
  it("tolerates month-length drift (28-31 day gaps) and day-of-month wobble", () => {
    expect(detectMonthly([t("SPOTIFY", "2026-06-30", 998), t("SPOTIFY", "2026-07-31", 998), t("SPOTIFY", "2026-08-31", 998), t("SPOTIFY", "2026-09-30", 998)], NOW)[0]).toMatchObject({ occurrences: 4, next_expected: "2026-10-30" });
  });
  it("irregular gaps or wildly different amounts break the run", () => {
    expect(detectMonthly([t("CAFE", "2026-07-01", 500), t("CAFE", "2026-07-09", 500), t("CAFE", "2026-09-12", 500)], NOW)).toEqual([]);
    expect(detectMonthly([t("SHOP", "2026-07-12", 1000), t("SHOP", "2026-08-12", 9000), t("SHOP", "2026-09-12", 1000)], NOW)).toEqual([]);
  });
  it("a price rise starts a new run: needs three at the new price", () => {
    const rows = [t("GYM", "2026-05-12", 5000), t("GYM", "2026-06-12", 5000), t("GYM", "2026-07-12", 5000), t("GYM", "2026-08-12", 8000), t("GYM", "2026-09-12", 8000)];
    expect(detectMonthly(rows, NOW)).toEqual([]);
    expect(detectMonthly([...rows, t("GYM", "2026-10-12", 8000)], "2026-10-14T04:00:00Z")[0]).toMatchObject({ expected_amount_sgd_minor: 8000, occurrences: 3 });
  });
  it("a service that went quiet 45+ days ago is not an active subscription", () => {
    expect(detectMonthly([t("OLD", "2026-03-12", 1000), t("OLD", "2026-04-12", 1000), t("OLD", "2026-05-12", 1000)], NOW)).toEqual([]);
  });
  it("ignores refunds/zero, same-day duplicates, and rows without a merchant", () => {
    expect(detectMonthly([t("A", "2026-07-12", 1000), t("A", "2026-07-12", 1000), t("A", "2026-08-12", 1000), { ...t("B", "2026-08-12", 1000), merchant: null }], NOW)).toEqual([]);
  });
  it("addOneMonth clamps", () => {
    expect(addOneMonth("2026-01-31")).toBe("2026-02-28");
    expect(addOneMonth("2026-12-15")).toBe("2027-01-15");
  });
});

describe("statement parsing", () => {
  it("amounts: CR, parentheses, minus, thousands, symbols", () => {
    expect(parseStatementAmount("1,234.56")).toBe(123456);
    expect(parseStatementAmount("S$ 12.50")).toBe(1250);
    expect(parseStatementAmount("12.50 CR")).toBe(-1250);
    expect(parseStatementAmount("(12.50)")).toBe(-1250);
    expect(parseStatementAmount("-12.50")).toBe(-1250);
    expect(parseStatementAmount("12.50 DR")).toBe(1250);
    expect(parseStatementAmount("n/a")).toBeNull();
    expect(parseStatementAmount("")).toBeNull();
  });
  it("dates: ISO, day-first, '12 Sep', year inference", () => {
    expect(parseStatementDate("2026-09-12", "2026-10-14")).toBe("2026-09-12");
    expect(parseStatementDate("12/09/2026", "2026-10-14")).toBe("2026-09-12");
    expect(parseStatementDate("12-09-26", "2026-10-14")).toBe("2026-09-12");
    expect(parseStatementDate("12 SEP 2026", "2026-10-14")).toBe("2026-09-12");
    expect(parseStatementDate("12 Sep", "2026-10-14")).toBe("2026-09-12");
    expect(parseStatementDate("28 Dec", "2026-01-05")).toBe("2025-12-28"); // statement in January, December charge
    expect(parseStatementDate("31/02/2026", "2026-10-14")).toBeNull();
    expect(parseStatementDate("garbage", "2026-10-14")).toBeNull();
  });
  it("CSV with a single signed amount column (charges positive)", () => {
    const csv = `Statement of account\nTransaction Date,Description,Amount\n12/09/2026,"YA KUN KAYA TOAST, SG",14.50\n13/09/2026,NTUC FAIRPRICE,"1,210.00"\n14/09/2026,PAYMENT - THANK YOU,-500.00\n15/09/2026,REFUND UNIQLO,-20.00\nnot a row`;
    const p = parseStatement(csv, "2026-10-14");
    expect(p.mode).toBe("csv");
    expect(p.rows.map((r) => [r.date, r.description, r.amount_minor])).toEqual([["2026-09-12", "YA KUN KAYA TOAST, SG", 1450], ["2026-09-13", "NTUC FAIRPRICE", 121000], ["2026-09-14", "PAYMENT - THANK YOU", -50000], ["2026-09-15", "REFUND UNIQLO", -2000]]);
    expect(p.skipped).toEqual(["not a row"]);
  });
  it("CSV where charges are negative gets flipped", () => {
    const p = parseStatement("Date,Details,Amount\n2026-09-12,KOPI,-3.20\n2026-09-13,TEA,-4.50\n2026-09-14,PAYMENT,100.00", "2026-10-14");
    expect(p.rows.map((r) => r.amount_minor)).toEqual([320, 450, -10000]);
  });
  it("CSV with separate Debit / Credit columns and semicolons", () => {
    const p = parseStatement("Date;Description;Debit;Credit\n12/09/2026;KOPI;3.20;\n13/09/2026;REFUND;;5.00", "2026-10-14");
    expect(p.rows.map((r) => r.amount_minor)).toEqual([320, -500]);
  });
  it("PDF-style text lines (post date, optional trans date, CR suffix)", () => {
    const text = `STATEMENT OF ACCOUNT\n12 SEP 13 SEP YA KUN KAYA TOAST SINGAPORE SG 14.50\n14 SEP GRAB*A-3JKD92 28.90\n20 SEP PAYMENT RECEIVED THANK YOU 500.00 CR\nTotal outstanding 1,234.00`;
    const p = parseStatement(text, "2026-10-14");
    expect(p.mode).toBe("text");
    expect(p.rows.map((r) => [r.date, r.description, r.amount_minor])).toEqual([["2026-09-12", "YA KUN KAYA TOAST SINGAPORE SG", 1450], ["2026-09-14", "GRAB*A-3JKD92", 2890], ["2026-09-20", "PAYMENT RECEIVED THANK YOU", -50000]]);
    expect(p.skipped.length).toBe(2);
  });
  it("payment detection", () => {
    expect(looksLikePayment("PAYMENT - THANK YOU")).toBe(true);
    expect(looksLikePayment("GIRO PAYMENT")).toBe(true);
    expect(looksLikePayment("UNIQLO REFUND")).toBe(false);
  });
});

describe("reconcile", () => {
  const row = (date: string, description: string, amount_minor: number) => ({ date, description, amount_minor, raw: "" });
  const tx = (id: string, date: string, sgd: number, merchant: string, extra: Partial<ExistingTxn> = {}): ExistingTxn => ({ id, occurred_at: `${date}T04:00:00Z`, amount_minor: sgd, currency: "SGD", amount_sgd_minor: sgd, merchant, is_refund: 0, status: "confirmed", ...extra });

  it("matches exact amount within a few days, adds the missing, ignores card payments, reports ours-not-on-statement", () => {
    const plan = reconcile(
      [row("2026-09-13", "YA KUN KAYA TOAST SG", 1450), row("2026-09-15", "UNKNOWN ONLINE SHOP", 9900), row("2026-09-20", "PAYMENT - THANK YOU", -50000)],
      [tx("a", "2026-09-12", 1450, "YA KUN KAYA TOAST"), tx("b", "2026-09-14", 777, "OLD THING")],
    );
    expect(plan.matched).toEqual([{ row: expect.objectContaining({ description: "YA KUN KAYA TOAST SG" }), txnId: "a" }]);
    expect(plan.toAdd.map((r) => r.description)).toEqual(["UNKNOWN ONLINE SHOP"]);
    expect(plan.payments).toHaveLength(1);
    expect(plan.notOnStatement).toEqual(["b"]);
  });
  it("corrects a foreign transaction's SGD estimate to the billed amount", () => {
    const jpy = tx("j", "2026-09-12", 1068, "LAWSON SHIBUYA", { currency: "JPY", amount_minor: 1200 });
    const plan = reconcile([row("2026-09-14", "LAWSON SHIBUYA TOKYO JP", 1112)], [jpy]);
    expect(plan.matched).toEqual([{ row: expect.anything(), txnId: "j", correctSgdTo: 1112 }]);
  });
  it("an SGD-typed guess of a foreign purchase still matches the billed amount when the merchant is clearly the same", () => {
    const guess = tx("g", "2026-09-12", 80000, "DON QUIJOTE");
    const plan = reconcile([row("2026-09-13", "DON QUIJOTE SHIBUYA JP", 81240)], [guess]);
    expect(plan.matched).toEqual([{ row: expect.anything(), txnId: "g", correctSgdTo: 81240 }]);
    expect(plan.toAdd).toEqual([]);
    // but not for a different merchant at a similar amount
    expect(reconcile([row("2026-09-13", "SOMEWHERE ELSE", 81240)], [guess]).matched).toEqual([]);
  });
  it("won't stretch a loose FX match onto an unrelated merchant", () => {
    const jpy = tx("j", "2026-09-12", 1068, "LAWSON SHIBUYA", { currency: "JPY", amount_minor: 1200 });
    const plan = reconcile([row("2026-09-14", "TOTALLY DIFFERENT PLACE", 1112)], [jpy]);
    expect(plan.matched).toEqual([]);
    expect(plan.toAdd).toHaveLength(1);
  });
  it("pairs identical purchases one-to-one (two S$5 coffees, one record) and is stable on re-import", () => {
    const plan = reconcile([row("2026-09-12", "KOPI", 500), row("2026-09-12", "KOPI", 500)], [tx("a", "2026-09-12", 500, "KOPI")]);
    expect(plan.matched).toHaveLength(1);
    expect(plan.toAdd).toHaveLength(1);
    const again = reconcile([row("2026-09-12", "KOPI", 500), row("2026-09-12", "KOPI", 500)], [tx("a", "2026-09-12", 500, "KOPI"), tx("b", "2026-09-12", 500, "KOPI", { })]);
    expect(again.matched).toHaveLength(2);
    expect(again.toAdd).toHaveLength(0);
  });
  it("outside the 4-day window is not a match; refunds match refunds only", () => {
    expect(reconcile([row("2026-09-20", "KOPI", 500)], [tx("a", "2026-09-12", 500, "KOPI")]).matched).toEqual([]);
    const plan = reconcile([row("2026-09-12", "UNIQLO", -2000)], [tx("c", "2026-09-12", 2000, "UNIQLO"), tx("r", "2026-09-12", 2000, "UNIQLO", { is_refund: 1 })]);
    expect(plan.matched.map((m) => m.txnId)).toEqual(["r"]);
  });
  it("void records never match", () => expect(reconcile([row("2026-09-12", "KOPI", 500)], [tx("a", "2026-09-12", 500, "KOPI", { status: "void" })]).toAdd).toHaveLength(1));
});

describe("csv", () => {
  it("quotes, escapes, CRLF, and neutralises formula injection", () => {
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell("=HYPERLINK(\"x\")")).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell("@evil")).toBe("'@evil");
    expect(csvCell("+1 call")).toBe("'+1 call");
    expect(csvCell("-12.50")).toBe("-12.50"); // a plain negative number stays a number
    expect(csvCell(-1250)).toBe("-1250");
    expect(csvCell(null)).toBe("");
    expect(toCsv([["a", 1], ["b,c", null]])).toBe("a,1\r\n\"b,c\",\r\n");
  });
});

describe("trip exclusion in the spend definition", () => {
  const base: SpendRow = { status: "confirmed", is_excluded: 0, is_reimbursable: 0, is_refund: 0, amount_sgd_minor: 1000, group_counts_as_spend: 1 };
  it("trip-excluded rows leave monthly views but count in the trip's own totals", () => {
    const r = { ...base, trip_excluded: 1 };
    expect(isSpend(r)).toBe(false);
    expect(isSpend(r, { ignoreTripExclusion: true })).toBe(true);
    expect(sumSpend([base, r])).toBe(1000);
    expect(sumSpend([base, r], { ignoreTripExclusion: true })).toBe(2000);
  });
  it("summarizeMonth excludes them; tripTotals includes them; excluded/void still don't count", () => {
    const row = (o: Partial<SummaryRow>): SummaryRow => ({ ...base, occurred_at: "2026-10-05T04:00:00Z", category_id: "travel", group_id: "lifestyle", ...o });
    const rows = [row({ amount_sgd_minor: 5000, trip_excluded: 1 }), row({ amount_sgd_minor: 700 }), row({ amount_sgd_minor: 900, trip_excluded: 1, is_excluded: 1 }), row({ amount_sgd_minor: 100, trip_excluded: 1, is_refund: 1 })];
    const s = summarizeMonth(rows, "2026-10", NOW);
    expect(s.total).toBe(700);
    expect(s.byGroupNonSpend).toEqual([]); // trip-excluded spend must not leak into the display-only non-spend bars
    const t = tripTotals(rows.filter((r) => r.trip_excluded));
    expect(t.total).toBe(5000 - 100);
    expect(t.count).toBe(2);
  });
});

describe("weekly digest text", () => {
  it("with and without a budget", () => {
    expect(weeklyDigestBody({ weekTotalSgd: 31200, lifestyleSpentSgd: 64200, lifestyleBudgetSgd: 90000, lifestyleExpectedSgd: 58000, top: [{ merchant: "Uniqlo", amountSgd: 12800 }, { merchant: "NTUC", amountSgd: 9600 }] }))
      .toBe("This week S$312 · Lifestyle S$642 / S$900 (pace S$580) · Biggest: Uniqlo S$128, NTUC S$96");
    expect(weeklyDigestBody({ weekTotalSgd: 0, lifestyleSpentSgd: 450, top: [] })).toBe("This week S$0.00 · Lifestyle S$4.50 this month");
  });
});
