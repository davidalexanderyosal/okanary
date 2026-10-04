import { describe, expect, it } from "vitest";
import {
  addCycle, annualSetAside, chargeMatches, findExistingSubscription, goalImpact, goalImpactText, matchAppleReceipt, missingCharge, monthlyEquivalent, priceChange,
  priceChangeMessage, quarterOf, renewalReminderDue, subscriptionFixedCosts, subscriptionTotals, trialReminderBody, trialReminderDue, yearlyEquivalent,
} from "./subscriptions";

describe("S: monthly equivalent and totals", () => {
  it("yearly ÷ 12, quarterly ÷ 3, weekly × 52 ÷ 12", () => {
    expect(monthlyEquivalent(1998, "monthly")).toBe(1998);
    expect(monthlyEquivalent(11_988, "yearly")).toBe(999);
    expect(monthlyEquivalent(3_000, "quarterly")).toBe(1_000);
    expect(monthlyEquivalent(1_000, "weekly")).toBe(4_333);
    expect(yearlyEquivalent(1_000, "weekly")).toBe(52_000);
  });
  it("totals per month/year, Essentials vs Lifestyle, only charging statuses", () => {
    const t = subscriptionTotals([
      { expected_sgd_minor: 1_998, cycle: "monthly", status: "active", group_id: "lifestyle" },
      { expected_sgd_minor: 12_000, cycle: "yearly", status: "active", group_id: "lifestyle" },
      { expected_sgd_minor: 3_000, cycle: "monthly", status: "cancel_intended", group_id: "essentials" },
      { expected_sgd_minor: 2_800, cycle: "monthly", status: "trial", group_id: "lifestyle" },
      { expected_sgd_minor: 999, cycle: "monthly", status: "candidate", group_id: "lifestyle" },
      { expected_sgd_minor: 999, cycle: "monthly", status: "dismissed", group_id: "lifestyle" },
    ]);
    expect(t).toEqual({ monthly: 1_998 + 1_000 + 3_000, yearly: 23_976 + 12_000 + 36_000, essentials: 3_000, lifestyle: 2_998, count: 3 });
  });
  it("annual set-aside: yearly ÷ 12 rounded up, never double counted with the monthly equivalent", () => {
    expect(annualSetAside(13_000)).toBe(1_084);
    expect(subscriptionFixedCosts([
      { expected_sgd_minor: 1_998, cycle: "monthly", status: "active", group_id: null },
      { expected_sgd_minor: 13_000, cycle: "yearly", status: "active", group_id: null },
    ])).toEqual({ monthly: 1_998, setAside: 1_084, total: 3_082 });
  });
  it("renewal dates step by cycle and clamp month ends", () => {
    expect(addCycle("2026-01-31", "monthly")).toBe("2026-02-28");
    expect(addCycle("2026-11-30", "quarterly")).toBe("2027-02-28");
    expect(addCycle("2028-02-29", "yearly")).toBe("2029-02-28");
    expect(addCycle("2026-12-29", "weekly")).toBe("2027-01-05");
  });
});

describe("S: price-change threshold", () => {
  it("max(2%, S$0.50) for SGD charges", () => {
    expect(priceChange(1_998, 2_048, false).changed).toBe(false); // +0.50 = threshold (0.40 → 0.50 floor)
    expect(priceChange(1_998, 2_049, false).changed).toBe(true);
    expect(priceChange(10_000, 10_200, false)).toEqual({ changed: false, diff: 200, threshold: 200 });
    expect(priceChange(10_000, 10_201, false).changed).toBe(true);
    expect(priceChange(10_000, 9_799, false).changed).toBe(true); // price drops are flagged too
  });
  it("allows ±3% extra for foreign-currency charges", () => {
    expect(priceChange(10_000, 10_450, true)).toEqual({ changed: false, diff: 450, threshold: 500 });
    expect(priceChange(10_000, 10_501, true).changed).toBe(true);
    expect(priceChange(10_000, 10_450, false).changed).toBe(true);
  });
  it("message with the yearly difference", () => {
    expect(priceChangeMessage("Netflix", 1_998, 2_298, "monthly")).toBe("Netflix went from S$19.98 to S$22.98 (+S$36/year).");
    expect(priceChangeMessage("Gym", 12_000, 10_000, "monthly")).toBe("Gym went from S$120.00 to S$100.00 (−S$240/year).");
  });
});

describe("S: missing charge, trial and renewal reminders (SGT)", () => {
  it("flags an active subscription more than 7 days late", () => {
    expect(missingCharge({ status: "active", next_renewal: "2026-10-05" }, "2026-10-12")).toBe(false);
    expect(missingCharge({ status: "active", next_renewal: "2026-10-05" }, "2026-10-13")).toBe(true);
    expect(missingCharge({ status: "cancelled", next_renewal: "2026-10-05" }, "2026-10-20")).toBe(false);
    expect(missingCharge({ status: "active", next_renewal: null }, "2026-10-20")).toBe(false);
  });
  it("trial reminder from 2 days before the end, by the SGT calendar", () => {
    // trial ends Thu 15 Oct 2026 → remind from Tue 13 Oct 00:00 SGT (= Mon 12 Oct 16:00 UTC)
    expect(trialReminderDue("2026-10-15", "2026-10-12T15:59:00Z")).toBe(false);
    expect(trialReminderDue("2026-10-15", "2026-10-12T16:00:00Z")).toBe(true);
    expect(trialReminderDue("2026-10-15", "2026-10-14T15:59:00Z")).toBe(true);
    expect(trialReminderDue("2026-10-15", "2026-10-14T16:00:00Z")).toBe(false); // the day it ends
    expect(trialReminderBody("ChatGPT", "2026-10-15", 2_800, "monthly")).toBe("ChatGPT trial ends Thu — S$28/mo after. Keep / Cancel");
  });
  it("annual renewal reminder 7 days before", () => {
    const s = { cycle: "yearly" as const, status: "active" as const, next_renewal: "2026-11-01" };
    expect(renewalReminderDue(s, "2026-10-24")).toBe(false);
    expect(renewalReminderDue(s, "2026-10-25")).toBe(true);
    expect(renewalReminderDue({ ...s, cycle: "monthly" }, "2026-10-25")).toBe(false);
    expect(quarterOf("2026-10-14")).toBe("2026-Q4");
    expect(quarterOf("2026-03-31")).toBe("2026-Q1");
  });
});

describe("S: matching", () => {
  it("a charge belongs to a subscription by merchant pattern", () => {
    expect(chargeMatches("NETFLIX.COM", "NETFLIX")).toBe(true);
    expect(chargeMatches("SPOTIFY P1234ABCD", "SPOTIFY")).toBe(true);
    expect(chargeMatches("NETFLIX", null)).toBe(false);
    expect(chargeMatches("SPOTIFY", "NETFLIX")).toBe(false);
  });
  it("merges a detected candidate into an existing manual entry (no duplicates)", () => {
    const subs = [
      { id: "m1", name: "Spotify", merchant_pattern: null, expected_sgd_minor: 1_198, status: "active" as const },
      { id: "m2", name: "Netflix", merchant_pattern: "NETFLIX", expected_sgd_minor: 1_998, status: "active" as const },
    ];
    expect(findExistingSubscription(subs, { merchant: "NETFLIX.COM", expected_sgd_minor: 2_298 })!.id).toBe("m2");
    expect(findExistingSubscription(subs, { merchant: "SPOTIFY", expected_sgd_minor: 1_198 })!.id).toBe("m1");
    expect(findExistingSubscription(subs, { merchant: "SPOTIFY", expected_sgd_minor: 5_000 })).toBeNull();
    expect(findExistingSubscription(subs, { merchant: "DISNEY PLUS", expected_sgd_minor: 1_198 })).toBeNull();
  });
  it("matches an Apple receipt to the APPLE.COM/BILL charge with the same amount within ±3 days", () => {
    const t = (id: string, merchant: string, amt: number, at: string, currency = "SGD") => ({ id, merchant, amount_minor: amt, currency, amount_sgd_minor: amt, occurred_at: at });
    const txns = [
      t("x", "APPLE.COM/BILL", 398, "2026-10-01T04:00:00Z"),
      t("a", "APPLE.COM/BILL", 1_498, "2026-10-05T04:00:00Z"),
      t("b", "APPLE.COM/BILL ITUNES.COM", 1_498, "2026-10-08T04:00:00Z"),
      t("c", "SPOTIFY", 1_498, "2026-10-07T04:00:00Z"),
    ];
    expect(matchAppleReceipt({ amount_minor: 1_498, currency: "SGD", date: "2026-10-07T10:00:00Z" }, txns)!.id).toBe("b");
    expect(matchAppleReceipt({ amount_minor: 1_498, currency: "SGD", date: "2026-10-12T00:00:00Z" }, txns)).toBeNull();
    expect(matchAppleReceipt({ amount_minor: 999, currency: "SGD", date: "2026-10-05T00:00:00Z" }, txns)).toBeNull();
  });
});

describe("S: cost in goal terms", () => {
  it("adds the monthly amount to the goal's pace and reports how much earlier it finishes", () => {
    // S$3,000 goal, S$500/mo pace → 6 months; +S$22.98/mo → about 5.74 months → ~1 week earlier
    const i = goalImpact(2_298, { target: 300_000, value: 0, pace: 50_000, returnBp: 0 });
    expect(i).toEqual({ weeksEarlier: 1, reachableOnlyIfCancelled: false });
    const big = goalImpact(10_000, { target: 1_200_000, value: 0, pace: 30_000, returnBp: 0 }); // 40 → 30 months
    expect(big.weeksEarlier).toBe(43);
    expect(goalImpactText("Netflix", 2_298, "Japan trip", i)).toBe("S$22.98/mo = S$276/yr. Cancelling moves 'Japan trip' 1 week earlier.");
    expect(goalImpactText("Gym", 10_000, "MBA", big)).toBe("S$100.00/mo = S$1,200/yr. Cancelling moves 'MBA' 10 months earlier.");
    expect(goalImpact(2_298, { target: 300_000, value: 0, pace: 0, returnBp: 0 })).toEqual({ weeksEarlier: null, reachableOnlyIfCancelled: true });
  });
});
