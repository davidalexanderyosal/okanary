import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import PostalMime from "postal-mime";
import { bankForDomain, dkimPass, receiptKindForSender } from "../src/email-auth";
import { htmlToText, sgtWallToUtc } from "../src/parsers/common";
import { parseAlert } from "../src/parsers";
import { parseAppleReceipt } from "../src/parsers/apple-receipt";
import { extractReceiptWithAi } from "../src/parsers/receipt-ai";

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

describe("receipt sender trust", () => {
  it("Apple family, Google Play receipts and common services; not Gmail's own mail or look-alikes", () => {
    expect(receiptKindForSender("no_reply@email.apple.com")).toBe("apple");
    expect(receiptKindForSender("do_not_reply@itunes.com")).toBe("apple");
    expect(receiptKindForSender("noreply@apple.com")).toBe("apple");
    expect(receiptKindForSender("googleplay-noreply@google.com")).toBe("receipt");
    expect(receiptKindForSender("info@mail.netflix.com")).toBe("receipt");
    expect(receiptKindForSender("x@email.openai.com")).toBe("receipt");
    expect(receiptKindForSender("receipts@spotify.com")).toBe("receipt");
    expect(receiptKindForSender("x@mail.anthropic.com")).toBe("receipt");
    expect(receiptKindForSender("noreply@youtube.com")).toBe("receipt");
    expect(receiptKindForSender("forwarding-noreply@google.com")).toBeNull();
    expect(receiptKindForSender("no_reply@apple.com.evil.example")).toBeNull();
    expect(receiptKindForSender("x@notapple.com")).toBeNull();
    expect(receiptKindForSender("")).toBeNull();
  });
});

describe("Apple receipt parser (UNVERIFIED, synthetic fixtures)", () => {
  it("single iCloud+ monthly subscription, renewing next month", async () => {
    const { text } = await body("synthetic-apple-receipt");
    expect(parseAppleReceipt(text)).toEqual({
      date: "2026-10-05T04:00:00.000Z", currency: "SGD", total_minor: 398,
      items: [{ name: "iCloud+ with 200 GB storage", amount_minor: 398, renews: "2026-11-05", cycle: "monthly" }],
    });
  });
  it("two items: a yearly app subscription and a one-off in-app purchase; bare $ is SGD", async () => {
    const { text } = await body("synthetic-apple-receipt-multi");
    expect(parseAppleReceipt(text)).toEqual({
      date: "2026-10-05T04:00:00.000Z", currency: "SGD", total_minor: 3696,
      items: [
        { name: "Pocket Budget Pro", amount_minor: 2998, renews: "2027-10-05", cycle: "yearly" },
        { name: "Gem Quest - 500 Gems", amount_minor: 698, renews: null, cycle: null },
      ],
    });
  });
  it("reads a one-line item, a foreign currency total and a cycle implied by the renewal date", () => {
    const t = "Date: 12 Jan 2027\nOrder ID: X\nYouTube Premium (Monthly) US$13.99\nRenews 12 Feb 2027\nStreamly   US$4.00\nRenews 12 Feb 2027\nTotal: US$17.99\n";
    expect(parseAppleReceipt(t)).toEqual({
      date: "2027-01-12T04:00:00.000Z", currency: "USD", total_minor: 1799,
      items: [
        { name: "YouTube Premium (Monthly)", amount_minor: 1399, renews: "2027-02-12", cycle: "monthly" },
        { name: "Streamly", amount_minor: 400, renews: "2027-02-12", cycle: "monthly" },
      ],
    });
  });
  it("returns null for a layout it can't read, and for a missing total or date", async () => {
    expect(parseAppleReceipt((await body("synthetic-apple-receipt-garbled")).text)).toBeNull();
    expect(parseAppleReceipt("Date: 5 Oct 2026\nOrder ID: X\nSomething S$3.98\n")).toBeNull();
    expect(parseAppleReceipt("Order ID: X\nSomething S$3.98\nTotal S$3.98\n")).toBeNull();
    expect(parseAppleReceipt("Date: 31 Feb 2026\nOrder ID: X\nSomething S$3.98\nTotal S$3.98\n")).toBeNull();
  });
});

describe("receipt AI extraction (mocked)", () => {
  const ai = (response: string) => ({ run: async () => ({ response }) });
  const arrived = "2026-10-05T00:00:00.000Z";
  it("validates and normalises the model's JSON", async () => {
    const r = await extractReceiptWithAi(ai('{"service":" Netflix ","amount":"19.98","currency":"sgd","date":"2026-10-05","renews":"2026-11-05"}'), "text", arrived);
    expect(r).toEqual({ service: "Netflix", amount_minor: 1998, currency: "SGD", date: "2026-10-05", renews: "2026-11-05", cycle: "monthly" });
  });
  it("falls back to the arrival day for an implausible date, drops an implausible renewal", async () => {
    const r = await extractReceiptWithAi(ai('{"service":"Spotify","amount":11.98,"currency":"SGD","date":"2019-01-01","renews":"2030-01-01"}'), "text", arrived);
    expect(r).toMatchObject({ service: "Spotify", amount_minor: 1198, date: "2026-10-05", renews: null, cycle: null });
  });
  it("rejects nonsense, missing fields, no JSON, a throwing model and no AI binding", async () => {
    expect(await extractReceiptWithAi(ai('{"service":"X","amount":"lots","currency":"SGD"}'), "t", arrived)).toBeNull();
    expect(await extractReceiptWithAi(ai('{"service":"","amount":"5","currency":"SGD"}'), "t", arrived)).toBeNull();
    expect(await extractReceiptWithAi(ai('{"service":"X","amount":"5","currency":"DOLLARS"}'), "t", arrived)).toBeNull();
    expect(await extractReceiptWithAi(ai("sorry, no idea"), "t", arrived)).toBeNull();
    expect(await extractReceiptWithAi({ run: async () => { throw new Error("boom"); } }, "t", arrived)).toBeNull();
    expect(await extractReceiptWithAi(undefined, "t", arrived)).toBeNull();
  });
});
