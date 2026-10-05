import { describe, expect, it } from "vitest";
import type { SubscriptionItem } from "./api";
import {
  buildPayload, candidateText, defaultNextRenewal, displayName, flagLines, groupSubscriptions, itemPriceText, missingText, monthlyHint, moneyText, nextLine,
  priceChangeText, priceCycleText, renewalText, rollForwardRenewal, sgdHint, sourceLabel, stillUsingList, trialText, type SubForm,
} from "./subscriptions";

function sub(over: Partial<SubscriptionItem> = {}): SubscriptionItem {
  return {
    id: "s1", name: "Netflix", catalogue_key: "netflix", amount_minor: 1998, currency: "SGD", expected_sgd_minor: 1998, cycle: "monthly", next_renewal: "2026-10-20",
    account_id: null, category_id: "subscriptions", source: "manual", status: "active", trial_ends: null, merchant_pattern: "NETFLIX", last_charged: null,
    pending_price_sgd_minor: null, group_id: "lifestyle", monthly_equivalent: 1998, yearly_equivalent: 23976,
    flags: { missing: false, price_change: false, trial_ending: false, renewal_soon: false }, cancel_url: null, goal_impact: null, ...over,
  };
}
const flagged = (flags: Partial<SubscriptionItem["flags"]>, over: Partial<SubscriptionItem> = {}) =>
  sub({ ...over, flags: { missing: false, price_change: false, trial_ending: false, renewal_soon: false, ...flags } });

describe("price and cycle text", () => {
  it("S$129/yr, S$11.98/mo, S$5/wk, S$30/qtr", () => {
    expect(priceCycleText(12900, "yearly")).toBe("S$129/yr");
    expect(priceCycleText(1198, "monthly")).toBe("S$11.98/mo");
    expect(priceCycleText(500, "weekly")).toBe("S$5/wk");
    expect(priceCycleText(3000, "quarterly")).toBe("S$30/qtr");
  });
  it("never rounds cents away, even above S$100", () => {
    expect(moneyText(12950)).toBe("S$129.50");
    expect(moneyText(100000)).toBe("S$1,000");
  });
  it("shows the billed currency when known", () => {
    expect(itemPriceText(sub({ amount_minor: 1200, currency: "USD", expected_sgd_minor: 1620 }))).toBe("US$12/mo");
    expect(itemPriceText(sub({ amount_minor: null, expected_sgd_minor: 1198 }))).toBe("S$11.98/mo");
    expect(sgdHint(sub({ currency: "USD", expected_sgd_minor: 1620 }))).toBe("≈ S$16.20");
    expect(sgdHint(sub())).toBeNull();
  });
});

describe("monthly equivalent hint", () => {
  it("only when the cycle is not monthly", () => {
    expect(monthlyHint(1075, "yearly")).toBe("≈ S$10.75/mo");
    expect(monthlyHint(2167, "weekly")).toBe("≈ S$21.67/mo");
    expect(monthlyHint(1000, "quarterly")).toBe("≈ S$10/mo");
    expect(monthlyHint(1198, "monthly")).toBeNull();
  });
});

describe("source badge and names", () => {
  it("labels every source", () => {
    expect(sourceLabel("detected")).toBe("Detected");
    expect(sourceLabel("manual")).toBe("Added by you");
    expect(sourceLabel("apple_receipt")).toBe("Apple receipt");
    expect(sourceLabel("email_receipt")).toBe("Email receipt");
  });
  it("prettifies UPPERCASE detected names only", () => {
    expect(displayName({ name: "NETFLIX.COM", source: "detected" })).toBe("Netflix.com");
    expect(displayName({ name: "SPOTIFY", source: "apple_receipt" })).toBe("Spotify");
    expect(displayName({ name: "HBO", source: "manual" })).toBe("HBO");
    expect(displayName({ name: "iCloud+", source: "detected" })).toBe("iCloud+");
  });
});

describe("flag texts", () => {
  it("price change uses the API numbers and a calm sign", () => {
    expect(priceChangeText(sub({ expected_sgd_minor: 1998, pending_price_sgd_minor: 2298 }))).toBe("Netflix went from S$19.98 to S$22.98 (+S$36/year)");
    expect(priceChangeText(sub({ expected_sgd_minor: 2298, pending_price_sgd_minor: 1998 }))).toBe("Netflix went from S$22.98 to S$19.98 (−S$36/year)");
    expect(priceChangeText(sub({ expected_sgd_minor: 12900, pending_price_sgd_minor: 13900, cycle: "yearly" }))).toBe("Netflix went from S$129 to S$139 (+S$10/year)");
    expect(priceChangeText(sub())).toBeNull();
  });
  it("missing uses the expected date", () => {
    expect(missingText({ next_renewal: "2026-10-05" })).toBe("No charge since 5 Oct — maybe cancelled?");
    expect(missingText({ next_renewal: null })).toBe("No recent charge — maybe cancelled?");
  });
  it("trial and renewal", () => {
    expect(trialText({ trial_ends: "2026-10-09", expected_sgd_minor: 2800, cycle: "monthly" })).toBe("Trial ends Fri — S$28/mo after");
    expect(renewalText({ next_renewal: "2026-11-01", expected_sgd_minor: 12900 })).toBe("Renews 1 Nov: S$129");
  });
  it("flagLines lists the active flags in order", () => {
    const s = flagged({ price_change: true, missing: true, renewal_soon: true }, { pending_price_sgd_minor: 2298, next_renewal: "2026-10-05" });
    expect(flagLines(s).map((l) => l.kind)).toEqual(["price_change", "missing", "renewal_soon"]);
    expect(flagLines(sub())).toEqual([]);
  });
  it("a price flag without a pending price adds no line", () => {
    expect(flagLines(flagged({ price_change: true }))).toEqual([]);
  });
});

describe("candidate and next-date lines", () => {
  it("New subscription? Spotify S$11.98/month", () => {
    expect(candidateText(sub({ name: "SPOTIFY", source: "detected", expected_sgd_minor: 1198, cycle: "monthly" }))).toBe("New subscription? Spotify S$11.98/month");
    expect(candidateText(sub({ name: "Gym", expected_sgd_minor: 9000, cycle: "quarterly" }))).toBe("New subscription? Gym S$90/quarter");
  });
  it("renewal, detected estimate, trial end", () => {
    expect(nextLine(sub())).toBe("Renews 20 Oct");
    expect(nextLine(sub({ source: "detected" }))).toBe("Next around 20 Oct");
    expect(nextLine(sub({ status: "trial", trial_ends: "2026-10-09" }))).toBe("Trial ends 9 Oct");
    expect(nextLine(sub({ next_renewal: null }))).toBeNull();
  });
});

describe("section grouping", () => {
  it("splits by status; flagged active items go to attention only", () => {
    const items = [
      sub({ id: "c", status: "candidate" }),
      flagged({ price_change: true }, { id: "p", pending_price_sgd_minor: 2298 }),
      flagged({ missing: true }, { id: "m" }),
      flagged({ trial_ending: true }, { id: "t", status: "trial", trial_ends: "2026-10-06" }),
      sub({ id: "a" }),
      sub({ id: "tr", status: "trial", trial_ends: "2026-11-30" }),
      sub({ id: "x", status: "cancel_intended" }),
      sub({ id: "y", status: "cancelled" }),
      sub({ id: "z", status: "dismissed" }),
    ];
    const g = groupSubscriptions(items);
    expect(g.candidate.map((s) => s.id)).toEqual(["c"]);
    expect(g.attention.map((s) => s.id)).toEqual(["p", "m", "t"]);
    expect(g.active.map((s) => s.id)).toEqual(["a", "tr"]);
    expect(g.cancelling.map((s) => s.id)).toEqual(["x"]);
    expect(g.ended.map((s) => s.id)).toEqual(["y", "z"]);
  });
  it("a flag with nothing to say keeps the item in Active", () => {
    expect(groupSubscriptions([flagged({ price_change: true })]).active).toHaveLength(1);
  });
  it("Still using? lists active items not yet answered", () => {
    const items = [sub({ id: "a" }), sub({ id: "b" }), sub({ id: "c", status: "cancel_intended" }), sub({ id: "d", status: "trial" })];
    expect(stillUsingList(items, new Set(["b"])).map((s) => s.id)).toEqual(["a"]);
  });
});

describe("default next renewal", () => {
  it("is one cycle after today (SGT)", () => {
    expect(defaultNextRenewal("weekly", "2026-10-04")).toBe("2026-10-11");
    expect(defaultNextRenewal("monthly", "2026-10-04")).toBe("2026-11-04");
    expect(defaultNextRenewal("quarterly", "2026-10-04")).toBe("2027-01-04");
    expect(defaultNextRenewal("yearly", "2026-10-04")).toBe("2027-10-04");
    expect(defaultNextRenewal("monthly", "2026-01-31")).toBe("2026-02-28");
  });
  it("rolls an overdue expected date forward by whole cycles", () => {
    expect(rollForwardRenewal("2026-08-05", "monthly", "2026-10-04")).toBe("2026-10-05");
    expect(rollForwardRenewal("2026-08-05", "monthly", "2026-10-05")).toBe("2026-11-05");
    expect(rollForwardRenewal("2026-01-31", "monthly", "2026-03-01")).toBe("2026-03-31");
    expect(rollForwardRenewal("2026-12-01", "monthly", "2026-10-04")).toBe("2026-12-01");
  });
});

describe("form payload", () => {
  const form: SubForm = { name: " Spotify ", catalogueKey: "spotify", price: "11.98", currency: "SGD", cycle: "monthly", nextRenewal: "2026-11-04", accountId: "", categoryId: "subscriptions", trial: false, trialEnds: "" };
  it("create sends integer minor units, trimmed name and no empty card", () => {
    expect(buildPayload(form, null)).toEqual({ input: { name: "Spotify", catalogue_key: "spotify", amount_minor: 1198, currency: "SGD", cycle: "monthly", next_renewal: "2026-11-04", trial_ends: null, status: "active", category_id: "subscriptions" } });
  });
  it("a trial charges on the day it ends, at the price after the trial", () => {
    const r = buildPayload({ ...form, trial: true, trialEnds: "2026-10-09", price: "28" }, null);
    expect(r).toMatchObject({ input: { status: "trial", trial_ends: "2026-10-09", next_renewal: "2026-10-09", amount_minor: 2800 } });
  });
  it("rejects a missing name, a bad price and a trial without an end date", () => {
    expect(buildPayload({ ...form, name: " " }, null)).toBe("Give it a name.");
    expect(buildPayload({ ...form, price: "abc" }, null)).toBe("Enter the price, above zero.");
    expect(buildPayload({ ...form, price: "0" }, null)).toBe("Enter the price, above zero.");
    expect(buildPayload({ ...form, trial: true }, null)).toBe("Pick the day the trial ends.");
  });
  it("uses the currency's exponent", () => {
    expect(buildPayload({ ...form, currency: "JPY", price: "1,200" }, null)).toMatchObject({ input: { amount_minor: 1200, currency: "JPY" } });
  });
  it("edit sends only what changed, so an untouched price keeps its flag and SGD value", () => {
    const orig = sub({ name: "Spotify", amount_minor: 1198, expected_sgd_minor: 1198, next_renewal: "2026-11-04", category_id: "subscriptions" });
    expect(buildPayload({ ...form, name: "Spotify" }, orig)).toEqual({ input: {} });
    expect(buildPayload({ ...form, name: "Spotify", price: "12.98" }, orig)).toEqual({ input: { amount_minor: 1298, currency: "SGD" } });
    expect(buildPayload({ ...form, name: "Spotify", accountId: "a1" }, orig)).toEqual({ input: { account_id: "a1" } });
  });
  it("edit ends a trial by setting it active", () => {
    const orig = sub({ name: "Spotify", amount_minor: 1198, expected_sgd_minor: 1198, status: "trial", trial_ends: "2026-10-09", next_renewal: "2026-10-09", category_id: "subscriptions" });
    expect(buildPayload({ ...form, name: "Spotify", trial: false, nextRenewal: "2026-10-09" }, orig)).toEqual({ input: { trial_ends: null, status: "active" } });
  });
});
