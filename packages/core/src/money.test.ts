import { describe, expect, it } from "vitest";
import { addMinor, allocate, convertMinor, currencyExponent, formatMoney, minorToDecimalString, parseMajorToMinor, percentOf } from "./money";

describe("parseMajorToMinor", () => {
  it("parses without float error", () => {
    expect(parseMajorToMinor("0.10", "SGD")).toBe(10);
    expect(parseMajorToMinor("0.30", "SGD")).toBe(30);
    expect(parseMajorToMinor("19.99", "SGD")).toBe(1999);
    expect(parseMajorToMinor("1,234.5", "SGD")).toBe(123450);
    expect(parseMajorToMinor("14", "SGD")).toBe(1400);
    expect(parseMajorToMinor(".5", "SGD")).toBe(50);
  });
  it("respects zero-decimal and three-decimal currencies", () => {
    expect(parseMajorToMinor("1,200", "JPY")).toBe(1200);
    expect(parseMajorToMinor("1.234", "KWD")).toBe(1234);
  });
  it("rounds extra digits half-up", () => {
    expect(parseMajorToMinor("1.005", "SGD")).toBe(101);
    expect(parseMajorToMinor("1.004", "SGD")).toBe(100);
    expect(parseMajorToMinor("10.7", "JPY")).toBe(11);
  });
  it("rejects garbage", () => {
    expect(() => parseMajorToMinor("", "SGD")).toThrow();
    expect(() => parseMajorToMinor("abc", "SGD")).toThrow();
    expect(() => parseMajorToMinor("1.2.3", "SGD")).toThrow();
  });
  it("handles negatives", () => expect(parseMajorToMinor("-3.5", "SGD")).toBe(-350));
});

describe("formatting", () => {
  it("minorToDecimalString", () => {
    expect(minorToDecimalString(5, "SGD")).toBe("0.05");
    expect(minorToDecimalString(-1250, "SGD")).toBe("-12.50");
    expect(minorToDecimalString(1200, "JPY")).toBe("1200");
    expect(minorToDecimalString(1234, "KWD")).toBe("1.234");
  });
  it("formatMoney", () => {
    expect(formatMoney(123450, "SGD")).toBe("S$1,234.50");
    expect(formatMoney(123450, "SGD", { compact: true })).toBe("S$1,234");
    expect(formatMoney(1450, "SGD", { compact: true })).toBe("S$14.50");
    expect(formatMoney(-500, "SGD")).toBe("-S$5.00");
    expect(formatMoney(1200, "JPY")).toBe("¥1,200");
  });
  it("exponents", () => {
    expect(currencyExponent("jpy")).toBe(0);
    expect(currencyExponent("XYZ")).toBe(2);
  });
});

describe("arithmetic", () => {
  it("addMinor is exact", () => expect(addMinor(10, 20)).toBe(30));
  it("addMinor rejects floats", () => expect(() => addMinor(0.1, 0.2)).toThrow());
  it("allocate sums exactly", () => {
    expect(allocate(100, 3)).toEqual([34, 33, 33]);
    expect(allocate(-100, 3).reduce((a, b) => a + b, 0)).toBe(-100);
    expect(allocate(5, 5)).toEqual([1, 1, 1, 1, 1]);
  });
  it("percentOf", () => {
    expect(percentOf(80, 100)).toBe(80);
    expect(percentOf(1, 3)).toBe(33);
    expect(percentOf(5, 0)).toBe(0);
  });
});

describe("convertMinor", () => {
  it("same currency is identity", () => expect(convertMinor(1234, "SGD", "SGD", 1)).toBe(1234));
  it("JPY -> SGD (exp 0 -> 2)", () => {
    // 1200 JPY at 0.0089 SGD/JPY = 10.68 SGD = 1068 minor
    expect(convertMinor(1200, "JPY", "SGD", 0.0089)).toBe(1068);
  });
  it("IDR -> SGD", () => {
    // 45,000.00 IDR (4,500,000 minor) at 0.0000835 = 3.7575 SGD -> 376
    expect(convertMinor(4_500_000, "IDR", "SGD", 0.0000835)).toBe(376);
  });
  it("USD -> SGD", () => expect(convertMinor(890, "USD", "SGD", 1.3)).toBe(1157));
  it("SGD -> JPY (exp 2 -> 0)", () => expect(convertMinor(1000, "SGD", "JPY", 112)).toBe(1120));
  it("rounds half up on magnitude, symmetric for negatives", () => {
    expect(convertMinor(1, "USD", "SGD", 1.5)).toBe(2);
    expect(convertMinor(-1, "USD", "SGD", 1.5)).toBe(-2);
  });
  it("rejects bad rates", () => expect(() => convertMinor(100, "USD", "SGD", 0)).toThrow());
});
