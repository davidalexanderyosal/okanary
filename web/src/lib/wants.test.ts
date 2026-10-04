import { sgtDate } from "@okanary/core";
import { describe, expect, it } from "vitest";
import { countdownText, decidedLine, defaultWaitForPrice, notBoughtText, parsePrefill, parseWantTab, skipOfferText, wantsAddLink } from "./wants";

describe("countdownText", () => {
  it("days, hours, ready", () => {
    expect(countdownText({ days: 6, hours: 12, due: false })).toBe("6 days left");
    expect(countdownText({ days: 1, hours: 3, due: false })).toBe("1 day left");
    expect(countdownText({ days: 0, hours: 12, due: false })).toBe("12 hours left");
    expect(countdownText({ days: 0, hours: 1, due: false })).toBe("1 hour left");
    expect(countdownText({ days: 0, hours: 0, due: true })).toBe("Ready");
  });
});

describe("defaultWaitForPrice", () => {
  it("7 days up to S$200, 30 above; 7 while empty; threshold is configurable", () => {
    expect(defaultWaitForPrice(5900)).toBe(7);
    expect(defaultWaitForPrice(20000)).toBe(7);
    expect(defaultWaitForPrice(20001)).toBe(30);
    expect(defaultWaitForPrice(35000)).toBe(30);
    expect(defaultWaitForPrice(0)).toBe(7);
    expect(defaultWaitForPrice(null)).toBe(7);
    expect(defaultWaitForPrice(5900, 5000)).toBe(30);
  });
});

describe("notBoughtText", () => {
  it("reads 'Not bought this year: S$412 (9 items)', singular for one, nothing for none", () => {
    expect(notBoughtText({ skipped_total_minor: 41200, skipped_count: 9 })).toBe("Not bought this year: S$412 (9 items)");
    expect(notBoughtText({ skipped_total_minor: 5900, skipped_count: 1 })).toBe("Not bought this year: S$59 (1 item)");
    expect(notBoughtText({ skipped_total_minor: 0, skipped_count: 0 })).toBeNull();
    expect(notBoughtText(undefined)).toBeNull();
  });
});

describe("skipOfferText", () => {
  it("offers the amount to the receiving goal", () => {
    expect(skipOfferText({ amount: 5900, name: "Japan trip", emoji: "🇯🇵" })).toBe("Add S$59 to 🇯🇵 Japan trip?");
    expect(skipOfferText({ amount: 450, name: "Laptop", emoji: null })).toBe("Add S$4.50 to Laptop?");
  });
});

describe("decidedLine", () => {
  it("shows the date; an early buy gets a neutral note", () => {
    const at = "2026-10-14T04:00:00.000Z";
    expect(decidedLine({ status: "skipped", decided_at: at, bought_early: 0 }, sgtDate)).toBe("Skipped 14 Oct");
    expect(decidedLine({ status: "bought", decided_at: at, bought_early: 0 }, sgtDate)).toBe("Bought 14 Oct");
    expect(decidedLine({ status: "bought", decided_at: at, bought_early: 1 }, sgtDate)).toBe("Bought 14 Oct · bought early");
  });
});

describe("Quick add hand-off and tabs", () => {
  it("round-trips amount, currency and merchant through the query string", () => {
    const link = wantsAddLink({ amountMinor: 1250, currency: "usd", name: " Starbucks " });
    expect(link).toBe("/wants?add=1&price=1250&cur=usd&name=Starbucks");
    expect(parsePrefill(new URL(link, "http://x").searchParams)).toEqual({ priceMinor: 1250, currency: "USD", name: "Starbucks" });
    expect(wantsAddLink({})).toBe("/wants?add=1");
    expect(parsePrefill(new URL("/wants?add=1", "http://x").searchParams)).toEqual({ priceMinor: null, currency: null, name: "" });
    expect(parsePrefill(new URL("/wants?tab=ready", "http://x").searchParams)).toBeNull();
    expect(parsePrefill(new URL("/wants?add=1&price=abc&cur=toolong", "http://x").searchParams)).toMatchObject({ priceMinor: null, currency: null });
  });
  it("tab param falls back to waiting", () => {
    expect(parseWantTab("ready")).toBe("ready");
    expect(parseWantTab("decided")).toBe("decided");
    expect(parseWantTab("x")).toBe("waiting");
    expect(parseWantTab(null)).toBe("waiting");
  });
});
