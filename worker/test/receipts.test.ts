import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { CRON_DAILY, runScheduled } from "../src/cron";
import type { Deps } from "../src/deps";
import { handleEmail, type InboundEmail } from "../src/email";
import type { Env } from "../src/env";
import { rematchAppleReceipts } from "../src/receipts";
import { _resetRateLimit } from "../src/routes/ingest";
import { count, harness, json, resetDb } from "./helpers";

// SYNTHETIC fixtures: the Apple receipt parser is UNVERIFIED (see parsers/apple-receipt.ts).
const fixture = (name: string) => env.FIXTURES[name]!;
const NOW = new Date("2026-10-06T04:00:00Z"); // Tue 6 Oct 2026, 12:00 SGT; the receipts are dated 5 Oct
type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function inbound(raw: string): InboundEmail & { forwarded: string[] } {
  const bytes = new TextEncoder().encode(raw);
  const forwarded: string[] = [];
  return { rawSize: bytes.byteLength, raw: new Response(bytes).body!, forward: async (to) => { forwarded.push(to); }, forwarded };
}
const FORWARD_TO = "owner@gmail.com";
const netflixAi = { run: async () => ({ response: '{"service":"Netflix","amount":"19.98","currency":"SGD","date":"2026-10-05","renews":"2026-11-05"}' }) };

beforeEach(async () => { _resetRateLimit(); await resetDb(); });

function setup(o: { ai?: Deps["ai"]; now?: Date } = {}) {
  const h = harness({ now: o.now ?? NOW });
  const e = { ...h.e, FORWARD_TO } as Env;
  const deps: Deps = { ...h.deps, ai: o.ai };
  const mail = (name: string) => handleEmail(inbound(fixture(name)), e, deps);
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await h.call(path, body === undefined ? { method } : json(method, body));
    return { status: r.status, body: (await r.json()) as Obj };
  };
  const apple = (amount_minor: number, at: string, o: Obj = {}) => call("POST", "/api/transactions", { amount_minor, category_id: "subscriptions", merchant: "APPLE.COM/BILL", occurred_at: at, ...o });
  return { h, e, deps, mail, call, apple };
}
const txn = async (id: string) => (await env.DB.prepare("SELECT * FROM transactions WHERE id = ?").bind(id).first<Obj>())!;
const subs = async () => (await env.DB.prepare("SELECT * FROM subscriptions ORDER BY created_at, id").all<Obj>()).results;
const raws = async () => (await env.DB.prepare("SELECT source, parse_status, transaction_id, error FROM raw_ingest ORDER BY received_at, id").all<Obj>()).results;
const charged = async (subId: string) => count(`SELECT COUNT(*) AS n FROM subscription_events WHERE subscription_id = '${subId}' AND kind = 'charged'`);

describe("Apple receipts", () => {
  it("labels the APPLE.COM/BILL charge 2 days earlier, creates + links the subscription, never pushes", async () => {
    const s = setup();
    const t = await s.apple(398, "2026-10-03T04:00:00Z");
    expect(t.status).toBe(201);
    const out = await s.mail("synthetic-apple-receipt");
    expect(out).toMatchObject({ action: "receipt", source: "apple", transactionId: t.body.id });

    const row = await txn(t.body.id);
    expect(row.note).toBe("Apple: iCloud+ with 200 GB storage");
    const [sub] = await subs();
    expect(sub).toMatchObject({
      name: "iCloud+ with 200 GB storage", source: "apple_receipt", status: "active", cycle: "monthly", amount_minor: 398, currency: "SGD",
      expected_sgd_minor: 398, next_renewal: "2026-11-05", merchant_pattern: "APPLE.COM/BILL", category_id: "subscriptions",
    });
    expect(row.recurring_id).toBe(sub!.id);
    expect(await charged(sub!.id as string)).toBe(1);
    expect(await raws()).toEqual([{ source: "email:apple", parse_status: "ok", transaction_id: t.body.id, error: null }]);
    expect(await count("SELECT COUNT(*) AS n FROM push_outbox")).toBe(0);
    expect(s.h.pushes).toHaveLength(0);
  });

  it("keeps an existing note after the label", async () => {
    const s = setup();
    const t = await s.apple(398, "2026-10-04T04:00:00Z", { note: "family plan" });
    await s.mail("synthetic-apple-receipt");
    expect((await txn(t.body.id)).note).toBe("Apple: iCloud+ with 200 GB storage | family plan");
  });

  it("two items: yearly app subscription + one-off in-app purchase", async () => {
    const s = setup();
    const t = await s.apple(3696, "2026-10-05T05:00:00Z");
    await s.mail("synthetic-apple-receipt-multi");
    expect((await txn(t.body.id)).note).toBe("Apple: Pocket Budget Pro, Gem Quest - 500 Gems");
    const all = await subs();
    expect(all).toHaveLength(1); // the in-app purchase is not a subscription
    expect(all[0]).toMatchObject({ name: "Pocket Budget Pro", cycle: "yearly", amount_minor: 2998, expected_sgd_minor: 2998, next_renewal: "2027-10-05", status: "active", source: "apple_receipt" });
    expect((await txn(t.body.id)).recurring_id).toBe(all[0]!.id);
  });

  it("receipt BEFORE the card charge: stored ok with no transaction; the daily cron labels it once the charge arrives", async () => {
    const s = setup();
    const out = await s.mail("synthetic-apple-receipt");
    expect(out).toMatchObject({ action: "receipt", source: "apple", transactionId: null });
    expect(await raws()).toEqual([{ source: "email:apple", parse_status: "ok", transaction_id: null, error: null }]);
    expect(await rematchAppleReceipts(s.e, s.deps)).toBe(0); // still no charge

    const t = await s.apple(398, "2026-10-05T10:00:00Z");
    expect((await txn(t.body.id)).note).toBeNull();
    await runScheduled(s.e, s.deps, CRON_DAILY);
    expect((await txn(t.body.id)).note).toBe("Apple: iCloud+ with 200 GB storage");
    expect((await raws())[0]).toMatchObject({ transaction_id: t.body.id, parse_status: "ok" });
    const all = await subs();
    expect(all).toHaveLength(1);
    expect((await txn(t.body.id)).recurring_id).toBe(all[0]!.id);
    expect(await charged(all[0]!.id as string)).toBe(1); // linked once (by the charge hook), not twice
    expect(await rematchAppleReceipts(s.e, s.deps)).toBe(0); // idempotent
  });

  it("the rematch only looks back 10 days", async () => {
    const s = setup();
    await s.mail("synthetic-apple-receipt");
    const t = await s.apple(398, "2026-10-05T10:00:00Z");
    const later = { ...s.deps, now: () => new Date("2026-10-20T04:00:00Z") };
    expect(await rematchAppleReceipts(s.e, later)).toBe(0);
    expect((await txn(t.body.id)).note).toBeNull();
  });

  it("an amount that differs, or a charge more than 3 days away, does not match", async () => {
    const s = setup();
    const wrong = await s.apple(399, "2026-10-05T04:00:00Z");
    const far = await s.apple(398, "2026-10-01T04:00:00Z");
    const other = await s.apple(398, "2026-10-05T04:00:00Z", { merchant: "NETFLIX.COM" });
    const out = await s.mail("synthetic-apple-receipt");
    expect(out).toMatchObject({ action: "receipt", transactionId: null });
    for (const t of [wrong, far, other]) expect((await txn(t.body.id)).note).toBeNull();
    expect(await rematchAppleReceipts(s.e, s.deps)).toBe(0);
  });

  it("one charge is claimed by one receipt only", async () => {
    const s = setup();
    await s.apple(398, "2026-10-05T04:00:00Z");
    await s.mail("synthetic-apple-receipt");
    const second = inbound(fixture("synthetic-apple-receipt").replace("synthetic-apple-receipt-1@", "synthetic-apple-receipt-1b@"));
    expect(await handleEmail(second, s.e, s.deps)).toMatchObject({ action: "receipt", transactionId: null });
  });

  it("untrusted (DKIM fails) Apple mail is forwarded and nothing is stored", async () => {
    const s = setup();
    const m = inbound(fixture("synthetic-spoofed-apple"));
    expect(await handleEmail(m, s.e, s.deps)).toEqual({ action: "forwarded", reason: "untrusted" });
    expect(m.forwarded).toEqual([FORWARD_TO]);
    expect(await count("SELECT COUNT(*) AS n FROM raw_ingest")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM subscriptions")).toBe(0);
  });

  it("is idempotent on Message-ID", async () => {
    const s = setup();
    await s.mail("synthetic-apple-receipt");
    expect(await s.mail("synthetic-apple-receipt")).toEqual({ action: "duplicate" });
    expect(await count("SELECT COUNT(*) AS n FROM raw_ingest")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM subscriptions")).toBe(1);
  });

  it("an unreadable receipt -> failed raw_ingest shown in Review, no subscription", async () => {
    const s = setup();
    expect(await s.mail("synthetic-apple-receipt-garbled")).toEqual({ action: "failed", error: "unparseable" });
    expect(await count("SELECT COUNT(*) AS n FROM subscriptions")).toBe(0);
    const rv = await s.call("GET", "/api/review");
    expect(rv.body.failed).toHaveLength(1);
    expect(rv.body.failed[0]).toMatchObject({ source: "email:apple" });
    expect(rv.body.failed[0].payload).toContain("iCloud storage plan");
  });

  it("an existing subscription (same service, similar name and price) is reused, not duplicated", async () => {
    const s = setup();
    const made = await s.call("POST", "/api/subscriptions", { name: "iCloud+", catalogue_key: "icloud", amount_minor: 398, cycle: "monthly", next_renewal: "2026-10-05" });
    expect(made.status).toBe(201);
    const t = await s.apple(398, "2026-10-05T04:00:00Z");
    await s.mail("synthetic-apple-receipt");
    const all = await subs();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: made.body.id, source: "manual" });
    expect((await txn(t.body.id)).recurring_id).toBe(made.body.id);
  });

  it("a dismissed subscription is not resurrected", async () => {
    const s = setup();
    await env.DB.prepare("INSERT INTO subscriptions (id, name, amount_minor, currency, cycle, expected_sgd_minor, source, status, created_at) VALUES ('d1','iCloud+ with 200 GB storage',398,'SGD','monthly',398,'apple_receipt','dismissed','2026-09-01T00:00:00Z')").run();
    const t = await s.apple(398, "2026-10-05T04:00:00Z");
    await s.mail("synthetic-apple-receipt");
    expect((await subs()).map((x) => x.id)).toEqual(["d1"]);
    expect((await txn(t.body.id)).note).toBe("Apple: iCloud+ with 200 GB storage"); // still labelled
    expect((await txn(t.body.id)).recurring_id).toBeNull();
  });
});

describe("generic service receipts (Workers AI)", () => {
  it("Netflix receipt + AI -> 'review' raw row in the Review inbox, counted in the summary, and a candidate subscription", async () => {
    const s = setup({ ai: netflixAi });
    const out = await s.mail("synthetic-netflix-receipt");
    expect(out).toMatchObject({ action: "receipt", source: "receipt" });
    const [sub] = await subs();
    expect(sub).toMatchObject({ name: "Netflix", source: "email_receipt", status: "candidate", cycle: "monthly", amount_minor: 1998, expected_sgd_minor: 1998, next_renewal: "2026-11-05" });
    expect(await raws()).toMatchObject([{ source: "email:receipt", parse_status: "review", transaction_id: null }]);

    const rv = await s.call("GET", "/api/review");
    expect(rv.body.failed).toHaveLength(1);
    expect(rv.body.failed[0].source).toBe("email:receipt");
    expect(rv.body.failed[0].payload).toMatch(/^Message-ID: <synthetic-netflix-receipt-1@mail\.netflix\.com>\nSubject: Your Netflix payment receipt\n\nExtracted: \{"service":"Netflix","amount_minor":1998,/);
    expect((await s.call("GET", "/api/summary?month=2026-10")).body.reviewCount).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM push_outbox")).toBe(0);

    // dismissing the raw row works as for failed rows and empties the inbox
    expect((await s.call("POST", `/api/raw-ingest/${rv.body.failed[0].id}/dismiss`)).status).toBe(200);
    expect((await s.call("GET", "/api/review")).body.failed).toHaveLength(0);
    expect((await s.call("GET", "/api/summary?month=2026-10")).body.reviewCount).toBe(0);
    // the candidate is confirmed on the Subscriptions screen
    expect((await s.call("POST", `/api/subscriptions/${sub!.id}/confirm`)).status).toBe(200);
    expect((await subs())[0]!.status).toBe("active");
  });

  it("merges into an existing Netflix subscription instead of adding a duplicate", async () => {
    const s = setup({ ai: netflixAi });
    const made = await s.call("POST", "/api/subscriptions", { name: "Netflix", catalogue_key: "netflix", amount_minor: 1998, cycle: "monthly", next_renewal: "2026-10-20" });
    await s.mail("synthetic-netflix-receipt");
    const all = await subs();
    expect(all.map((x) => x.id)).toEqual([made.body.id]);
    expect(all[0]!.status).toBe("active");
    expect((await raws())[0]).toMatchObject({ parse_status: "review" });
  });

  it("a foreign-currency receipt gets its SGD value from the ECB rate", async () => {
    const usd = { run: async () => ({ response: '{"service":"Spotify","amount":"10.00","currency":"USD","date":"2026-10-05","renews":null}' }) };
    const h = harness({ now: NOW, rates: { USD: 1.3 } });
    const e = { ...h.e, FORWARD_TO } as Env;
    const raw = fixture("synthetic-netflix-receipt").replace("mail.netflix.com", "spotify.com").replace("synthetic-netflix-receipt-1@spotify.com", "synthetic-spotify-1@spotify.com");
    expect(await handleEmail(inbound(raw), e, { ...h.deps, ai: usd })).toMatchObject({ action: "receipt", source: "receipt" });
    expect((await subs())[0]).toMatchObject({ name: "Spotify", currency: "USD", amount_minor: 1000, expected_sgd_minor: 1300, status: "candidate" });
  });

  it("without AI, or when the model returns nonsense -> failed", async () => {
    const s = setup();
    expect(await s.mail("synthetic-netflix-receipt")).toEqual({ action: "failed", error: "unparseable" });
    expect(await count("SELECT COUNT(*) AS n FROM subscriptions")).toBe(0);
    expect(await raws()).toMatchObject([{ source: "email:receipt", parse_status: "failed" }]);
    expect((await s.call("GET", "/api/review")).body.failed).toHaveLength(1);

    await resetDb();
    const bad = setup({ ai: { run: async () => ({ response: "I cannot read this" }) } });
    expect(await bad.mail("synthetic-netflix-receipt")).toEqual({ action: "failed", error: "unparseable" });
    expect(await count("SELECT COUNT(*) AS n FROM subscriptions")).toBe(0);
  });

  it("duplicate Message-ID and untrusted senders behave like bank mail", async () => {
    const s = setup({ ai: netflixAi });
    await s.mail("synthetic-netflix-receipt");
    expect(await s.mail("synthetic-netflix-receipt")).toEqual({ action: "duplicate" });
    const forged = inbound(fixture("synthetic-netflix-receipt").replace("dkim=pass", "dkim=fail").replace("synthetic-netflix-receipt-1@", "synthetic-netflix-forged@"));
    expect(await handleEmail(forged, s.e, s.deps)).toEqual({ action: "forwarded", reason: "untrusted" });
    expect(await count("SELECT COUNT(*) AS n FROM subscriptions")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM raw_ingest")).toBe(1);
  });
});
