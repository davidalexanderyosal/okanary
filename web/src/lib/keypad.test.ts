import { describe, expect, it } from "vitest";
import { displayTyped, keypadMinor, pressKey, type KeypadKey } from "./keypad";

const type = (keys: KeypadKey[], cur = "SGD") => keys.reduce((s, k) => pressKey(s, k, cur), "");

describe("keypad", () => {
  it("types 14.50", () => {
    const s = type(["1", "4", ".", "5", "0"]);
    expect(s).toBe("14.50");
    expect(keypadMinor(s, "SGD")).toBe(1450);
  });
  it("limits decimals to the currency exponent", () => {
    expect(type(["1", ".", "2", "3", "4"])).toBe("1.23");
    expect(type(["1", ".", "5"], "JPY")).toBe("15"); // "." ignored for zero-decimal JPY
  });
  it("collapses leading zeros and starts '.' as 0.", () => {
    expect(type(["0", "0", "5"])).toBe("5");
    expect(type(["."])).toBe("0.");
  });
  it("backspace and clear", () => {
    expect(type(["1", "2", "back"])).toBe("1");
    expect(type(["1", "2", "clear"])).toBe("");
    expect(type(["back"])).toBe("");
  });
  it("ignores a second decimal point", () => expect(type(["1", ".", ".", "5"])).toBe("1.5"));
  it("caps integer digits", () => expect(type(Array(12).fill("9") as KeypadKey[]).length).toBe(9));
  it("keypadMinor handles empty, '.' and trailing dot", () => {
    expect(keypadMinor("", "SGD")).toBe(0);
    expect(keypadMinor(".", "SGD")).toBe(0);
    expect(keypadMinor("7.", "SGD")).toBe(700);
  });
  it("displayTyped groups thousands", () => {
    expect(displayTyped("")).toBe("0");
    expect(displayTyped("1234567.8")).toBe("1,234,567.8");
    expect(displayTyped("12.")).toBe("12.");
  });
});
