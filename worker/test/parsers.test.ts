import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import PostalMime from "postal-mime";
import { bankForDomain, dkimPass } from "../src/email-auth";
import { htmlToText, sgtWallToUtc } from "../src/parsers/common";
import { parseAlert } from "../src/parsers";

// Fixtures are SYNTHETIC (invented). See worker/fixtures and PROGRESS.md: DBS/Citi parsers are UNVERIFIED until real samples exist.
const fx = (name: string) => env.FIXTURES[name]!;
async function body(name: string) {
  const m = await PostalMime.parse(fx(name));
  return { text: m.text?.trim() || htmlToText(m.html ?? ""), sentAt: new Date(m.date!).toISOString() };
}

describe("DBS parser (UNVERIFIED, synthetic fixtures)", () => {
  it("labeled layout, SGD", async () => {
    const { text, sentAt } = await body("synthetic-dbs-sgd");
    expect(parseAlert("dbs", text, sentAt)).toEqual({ amount_minor: 1450, currency: "SGD", merchant: "YA KUN KAYA TOAST", card_last4: "1234", occurred_at: "2026-10-14T04:10:00.000Z" });
  });
  it("foreign currency amount (JPY has no minor units)", async () => {
    const { text, sentAt } = await body("synthetic-dbs-foreign");
    expect(parseAlert("dbs", text, sentAt)).toMatchObject({ amount_minor: 1200, currency: "JPY", merchant: "LAWSON SHIBUYA", occurred_at: "2026-10-15T12:30:00.000Z" });
  });
  it("sentence layout with explicit year", async () => {
    const { text, sentAt } = await body("synthetic-dbs-sentence");
    expect(parseAlert("dbs", text, sentAt)).toMatchObject({ amount_minor: 890, currency: "SGD", merchant: "TOAST BOX", card_last4: "1234", occurred_at: "2026-10-16T01:03:00.000Z" });
  });
  it("HTML-only email (table rows become Label: value lines)", async () => {
    const { text, sentAt } = await body("synthetic-dbs-html");
    expect(parseAlert("dbs", text, sentAt)).toMatchObject({ amount_minor: 2500, merchant: "COLD STORAGE & CO", card_last4: "1234" });
  });
  it("returns null for a layout it can't read (-> LLM fallback)", async () => {
    const { text, sentAt } = await body("synthetic-dbs-garbled");
    expect(parseAlert("dbs", text, sentAt)).toBeNull();
  });
});

describe("Citi parser (UNVERIFIED, synthetic fixtures)", () => {
  it("sentence layout", async () => {
    const { text, sentAt } = await body("synthetic-citi-sgd");
    expect(parseAlert("citi", text, sentAt)).toEqual({ amount_minor: 2890, currency: "SGD", merchant: "GRAB*A-3JKD92 SINGAPORE SG", card_last4: "4321", occurred_at: "2026-10-14T11:05:00.000Z" });
  });
  it("labeled layout", async () => {
    const { text, sentAt } = await body("synthetic-citi-labeled");
    expect(parseAlert("citi", text, sentAt)).toMatchObject({ amount_minor: 680, merchant: "STARBUCKS VIVOCITY", card_last4: "4321", occurred_at: "2026-10-15T00:18:00.000Z" });
  });
});

describe("year inference", () => {
  it("uses the received year", () => expect(sgtWallToUtc(14, 10, undefined, 12, 10, "2026-10-14T05:00:00Z")).toBe("2026-10-14T04:10:00.000Z"));
  it("a 31 Dec purchase read on 1 Jan belongs to the previous year", () => expect(sgtWallToUtc(31, 12, undefined, 23, 30, "2027-01-01T00:00:00Z")).toBe("2026-12-31T15:30:00.000Z"));
  it("explicit year wins", () => expect(sgtWallToUtc(1, 3, 2025, 9, 0, "2026-10-14T05:00:00Z")).toBe("2025-03-01T01:00:00.000Z"));
});

describe("sender trust", () => {
  it("bank by domain incl. subdomains, extra domains, and rejects look-alikes", () => {
    expect(bankForDomain("dbs.com")).toBe("dbs");
    expect(bankForDomain("alerts.dbs.com.sg")).toBe("dbs");
    expect(bankForDomain("citibank.com.sg")).toBe("citi");
    expect(bankForDomain("dbs.com.evil.example")).toBeNull();
    expect(bankForDomain("notdbs.com")).toBeNull();
    expect(bankForDomain("bank.example", "bank.example:citi")).toBe("citi");
  });
  it("dkim must pass AND align with the From domain", () => {
    expect(dkimPass(["mx.cloudflare.net; dkim=pass header.d=dbs.com header.s=x; spf=fail"], "dbs.com")).toBe(true);
    expect(dkimPass(["mx.cloudflare.net; dkim=pass header.d=mail.dbs.com"], "dbs.com")).toBe(true);
    expect(dkimPass(["mx.cloudflare.net; dkim=fail header.d=dbs.com"], "dbs.com")).toBe(false);
    expect(dkimPass(["mx.cloudflare.net; dkim=pass header.d=evil.example"], "dbs.com")).toBe(false);
    expect(dkimPass(["mx.cloudflare.net; spf=pass"], "dbs.com")).toBe(false);
    expect(dkimPass([], "dbs.com")).toBe(false);
  });
});
