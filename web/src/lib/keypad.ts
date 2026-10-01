import { currencyExponent, parseMajorToMinor } from "@okanary/core";

export type KeypadKey = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "." | "back" | "clear";

const MAX_INT_DIGITS = 9;

/** Pure reducer for the Quick-add keypad. State is the decimal string typed so far ("" = nothing). */
export function pressKey(cur: string, key: KeypadKey, currency: string): string {
  const exp = currencyExponent(currency);
  if (key === "clear") return "";
  if (key === "back") return cur.slice(0, -1);
  if (key === ".") {
    if (exp === 0 || cur.includes(".")) return cur;
    return cur === "" ? "0." : cur + ".";
  }
  const [int = "", frac] = cur.split(".");
  if (frac !== undefined) return frac.length >= exp ? cur : cur + key;
  if (int === "0") return key === "0" ? cur : key; // no leading zeros
  return int.length >= MAX_INT_DIGITS ? cur : cur + key;
}

/** Minor units for the typed string; 0 if empty/invalid. */
export function keypadMinor(s: string, currency: string): number {
  if (s === "" || s === ".") return 0;
  try {
    return parseMajorToMinor(s.endsWith(".") ? s.slice(0, -1) : s, currency);
  } catch {
    return 0;
  }
}

/** What to show on screen: thousands separators while typing, keeps trailing '.'. */
export function displayTyped(s: string): string {
  if (s === "") return "0";
  const [int = "0", frac] = s.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac === undefined ? grouped : `${grouped}.${frac}`;
}
