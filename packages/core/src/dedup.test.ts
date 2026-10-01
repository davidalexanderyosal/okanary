import { describe, expect, it } from "vitest";
import { amountsClose, bestCandidate, matchStrength, type DedupTxn } from "./dedup";

const t = (o: Partial<DedupTxn>): DedupTxn => ({ id: "a", source: "applepay", account_id: "card1", currency: "SGD", amount_minor: 1450, occurred_at: "2026-10-14T04:00:00Z", merchant: "YA KUN KAYA TOAST", ...o });
const email = (o: Partial<DedupTxn> = {}) => t({ id: "e", source: "email", merchant: "YA KUN KAYA TOAST", occurred_at: "2026-10-14T04:10:00Z", ...o });

describe("amountsClose", () => {
  it("within 1%", () => {
    expect(amountsClose(1450, 1450)).toBe(true);
    expect(amountsClose(10000, 10100)).toBe(true);
    expect(amountsClose(10000, 10102)).toBe(false);
    expect(amountsClose(50, 51)).toBe(true); // at least 1 minor unit tolerance
    expect(amountsClose(50, 53)).toBe(false);
  });
});

describe("matchStrength", () => {
  it("same card + currency + amount + time + merchant => match", () => expect(matchStrength(t({}), email())).toBe("match"));
  it("amount differing by <=1% still matches (FX/rounding)", () => expect(matchStrength(t({ amount_minor: 10000 }), email({ amount_minor: 10100 }))).toBe("match"));
  it("different currency, amount, window, card => none", () => {
    expect(matchStrength(t({}), email({ currency: "USD" }))).toBe("none");
    expect(matchStrength(t({}), email({ amount_minor: 1700 }))).toBe("none");
    expect(matchStrength(t({}), email({ occurred_at: "2026-10-14T04:31:00Z" }))).toBe("none");
    expect(matchStrength(t({}), email({ account_id: "card2" }))).toBe("none");
  });
  it("exactly 30 minutes is inside the window", () => expect(matchStrength(t({}), email({ occurred_at: "2026-10-14T04:30:00Z" }))).toBe("match"));
  it("unknown card on one side => maybe, not auto-merge", () => expect(matchStrength(t({}), email({ account_id: null }))).toBe("maybe"));
  it("loosely similar merchant => maybe", () => expect(matchStrength(t({}), email({ merchant: "YA KUN INTERNATIONAL PTE LTD HQ" }))).toBe("maybe"));
  it("unrelated merchant => none", () => expect(matchStrength(t({}), email({ merchant: "STARBUCKS" }))).toBe("none"));
  it("never matches within one source, or with manual/import", () => {
    expect(matchStrength(t({}), t({ id: "b" }))).toBe("none");
    expect(matchStrength(t({}), email({ source: "manual" }))).toBe("none");
  });
  it("is symmetric", () => expect(matchStrength(email(), t({}))).toBe("match"));
});

describe("bestCandidate", () => {
  it("prefers match over maybe, then the closest in time", () => {
    const inc = email();
    const far = t({ id: "far", occurred_at: "2026-10-14T03:50:00Z" });
    const near = t({ id: "near", occurred_at: "2026-10-14T04:08:00Z" });
    const maybe = t({ id: "maybe", account_id: null, occurred_at: "2026-10-14T04:10:00Z" });
    expect(bestCandidate(inc, [maybe, far, near])).toMatchObject({ candidate: { id: "near" }, strength: "match" });
    expect(bestCandidate(inc, [maybe])).toMatchObject({ candidate: { id: "maybe" }, strength: "maybe" });
    expect(bestCandidate(inc, [])).toBeNull();
  });
});
