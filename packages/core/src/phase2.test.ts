import { describe, expect, it } from "vitest";
import { merchantSimilarity, normalizeMerchant } from "./merchant";
import { parseShortcutAmount } from "./parse-amount";
import { findRule, type MerchantRule } from "./rules";

describe("parseShortcutAmount", () => {
  it.each([
    ["S$12.50", 1250, "SGD"],
    ["Rp 45.000", 4_500_000, "IDR"],
    ["Rp45.000,50", 4_500_050, "IDR"],
    ["¥1,200", 1200, "JPY"],
    ["$8.90", 890, "SGD"],
    ["US$8.90", 890, "USD"],
    ["12.50 SGD", 1250, "SGD"],
    ["€1.234,56", 123456, "EUR"],
    ["£1,234.56", 123456, "GBP"],
    ["SGD 1,200", 120000, "SGD"],
    ["RM 15.00", 1500, "MYR"],
    ["14", 1400, "SGD"],
    ["S$ 1,234.50", 123450, "SGD"],
    ["฿350", 35000, "THB"],
    ["12,50 EUR", 1250, "EUR"],
  ])("%s", (input, minor, cur) => {
    expect(parseShortcutAmount(input)).toEqual({ amount_minor: minor, currency: cur });
  });
  it("accepts numbers with a fallback currency", () => expect(parseShortcutAmount(8.9)).toEqual({ amount_minor: 890, currency: "SGD" }));
  it("rejects junk and zero", () => {
    expect(parseShortcutAmount("hello")).toBeNull();
    expect(parseShortcutAmount("S$0.00")).toBeNull();
    expect(parseShortcutAmount("")).toBeNull();
    expect(parseShortcutAmount(-5)).toBeNull();
  });
});

describe("normalizeMerchant", () => {
  it.each([
    ["SQ *YA KUN KAYA TOAST", "YA KUN KAYA TOAST"],
    ["PAYPAL *SPOTIFY", "SPOTIFY"],
    ["GPAY*Grab", "GRAB"],
    ["GRAB*A-3JKD92 SINGAPORE SG", "GRAB"],
    ["  Starbucks   #1234  ", "STARBUCKS"],
    ["NTUC FAIRPRICE 123 SINGAPORE", "NTUC FAIRPRICE"],
    ["AMZN Mktp SG*AB12CD34", "AMZN MKTP"],
    ["Ya Kun Kaya Toast", "YA KUN KAYA TOAST"],
    ["COLD STORAGE SG", "COLD STORAGE"],
  ])("%s -> %s", (raw, out) => expect(normalizeMerchant(raw)).toBe(out));
  it("never returns empty", () => expect(normalizeMerchant("123")).not.toBe(""));
  it("similarity", () => {
    expect(merchantSimilarity("YA KUN KAYA TOAST", "SQ *YA KUN")).toBeGreaterThan(0.6);
    expect(merchantSimilarity("GRAB", "STARBUCKS")).toBe(0);
  });
});

describe("findRule", () => {
  const r = (o: Partial<MerchantRule>): MerchantRule => ({ id: "x", match_type: "exact", pattern: "", category_id: "c", set_excluded: 0, priority: 0, ...o });
  it("exact beats prefix beats contains at equal priority", () => {
    const rules = [r({ id: "c", match_type: "contains", pattern: "GRAB" }), r({ id: "p", match_type: "prefix", pattern: "GRAB" }), r({ id: "e", match_type: "exact", pattern: "GRAB" })];
    expect(findRule(rules, "GRAB")!.id).toBe("e");
    expect(findRule(rules, "GRABFOOD")!.id).toBe("p");
    expect(findRule(rules, "MY GRAB RIDE")!.id).toBe("c");
  });
  it("priority wins over specificity", () => {
    expect(findRule([r({ id: "hi", match_type: "contains", pattern: "GRAB", priority: 5 }), r({ id: "ex", pattern: "GRAB" })], "GRAB")!.id).toBe("hi");
  });
  it("supports GRAB* glob shorthand and regex, case-insensitive", () => {
    expect(findRule([r({ match_type: "prefix", pattern: "grab*" })], "GRAB")).not.toBeNull();
    expect(findRule([r({ match_type: "regex", pattern: "^SHELL\\b" })], "SHELL 123")).not.toBeNull();
    expect(findRule([r({ match_type: "regex", pattern: "(" })], "X")).toBeNull();
  });
  it("no match", () => expect(findRule([r({ pattern: "A" })], "B")).toBeNull());
});
