import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { emailHealthAlerts, promoteStalePending, runScheduled } from "../src/cron";
import type { Deps } from "../src/deps";
import type { Env } from "../src/env";
import { handleEmail, type InboundEmail } from "../src/email";
import { _resetRateLimit } from "../src/routes/ingest";

// SYNTHETIC fixtures: see PROGRESS.md (parsers UNVERIFIED).
const fixture = (name: string) => env.FIXTURES[name]!;

const NOW = new Date("2026-10-14T04:30:00Z"); // 12:30 SGT
const TOKEN = "tok";
const FORWARD_TO = "owner@gmail.com";

function inbound(raw: string): InboundEmail & { forwarded: string[] } {
  const bytes = new TextEncoder().encode(raw);
  const forwarded: string[] = [];
  return { rawSize: bytes.byteLength, raw: new Response(bytes).body!, forward: async (to) => { forwarded.push(to); }, forwarded };
}
const e = { ...env, INGEST_TOKEN: TOKEN, FORWARD_TO } as unknown as Env;
const deps = (o: Partial<Deps> = {}): Deps => ({ now: () => NOW, fetch: (async () => new Response("{}", { status: 404 })) as typeof fetch, ...o });
const app = (d: Deps) => createApp(d);
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const applePay = (d: Deps, body: Record<string, unknown>) =>
  app(d).request("/api/ingest/applepay", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) }, e);
const count = async (sql: string) => (await env.DB.prepare(sql).first<{ n: number }>())!.n;

async function addCard() {
  const r = await app(deps()).request("/api/accounts", json("POST", { name: "DBS Altitude", kind: "credit", bank: "DBS", last4: "1234", wallet_card_name: "DBS Altitude Visa" }), e);
  return (await r.json<{ id: string }>()).id;
}

beforeEach(async () => {
  _resetRateLimit();
  await env.DB.exec("DELETE FROM duplicate_candidates; DELETE FROM raw_ingest; DELETE FROM transactions; DELETE FROM merchant_rules; DELETE FROM accounts; DELETE FROM alert_log; DELETE FROM push_subscriptions; DELETE FROM fx_rates;");
  await env.DB.exec("DELETE FROM settings WHERE key NOT IN ('base_currency','timezone')");
});

describe("email handler: routing and trust", () => {
  it("forwards non-alert mail (Gmail forwarding verification) to the owner and stores nothing", async () => {
    const m = inbound(fixture("synthetic-gmail-forwarding-verification"));
    expect(await handleEmail(m, e, deps())).toEqual({ action: "forwarded", reason: "not-an-alert" });
    expect(m.forwarded).toEqual([FORWARD_TO]);
    expect(await count("SELECT COUNT(*) AS n FROM raw_ingest")).toBe(0);
  });
  it("a forged DBS email (DKIM fails) is forwarded, never parsed or stored", async () => {
    const m = inbound(fixture("synthetic-spoofed-dbs"));
    expect(await handleEmail(m, e, deps())).toEqual({ action: "forwarded", reason: "untrusted" });
    expect(m.forwarded).toEqual([FORWARD_TO]);
    expect(await count("SELECT COUNT(*) AS n FROM transactions")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM raw_ingest")).toBe(0);
  });
  it("an unexpected error forwards the mail so nothing is lost", async () => {
    const m = inbound(fixture("synthetic-dbs-sgd"));
    const broken = { ...e, DB: undefined } as unknown as Env;
    expect(await handleEmail(m, broken, deps())).toEqual({ action: "forwarded", reason: "error" });
    expect(m.forwarded).toEqual([FORWARD_TO]);
  });
  it("without FORWARD_TO configured nothing is forwarded but nothing crashes", async () => {
    const m = inbound(fixture("synthetic-gmail-forwarding-verification"));
    expect((await handleEmail(m, { ...e, FORWARD_TO: undefined } as Env, deps())).action).toBe("forwarded");
    expect(m.forwarded).toEqual([]);
  });
});

describe("email handler: capture", () => {
  it("DBS alert -> confirmed transaction with the right amount, merchant, account and time; raw is linked", async () => {
    const card = await addCard();
    const out = await handleEmail(inbound(fixture("synthetic-dbs-sgd")), e, deps());
    expect(out).toMatchObject({ action: "captured", merged: false, status: "confirmed", via: "regex" });
    const t = await env.DB.prepare("SELECT * FROM transactions").first<Record<string, unknown>>();
    expect(t).toMatchObject({ amount_minor: 1450, currency: "SGD", amount_sgd_minor: 1450, merchant: "YA KUN KAYA TOAST", source: "email", account_id: card, occurred_at: "2026-10-14T04:10:00.000Z" });
    expect(await env.DB.prepare("SELECT source, parse_status, transaction_id FROM raw_ingest").first()).toEqual({ source: "email:dbs", parse_status: "ok", transaction_id: t!.id });
  });
  it("is idempotent on Message-ID (Gmail forwarding the same mail twice)", async () => {
    await handleEmail(inbound(fixture("synthetic-dbs-sgd")), e, deps());
    expect(await handleEmail(inbound(fixture("synthetic-dbs-sgd")), e, deps())).toEqual({ action: "duplicate" });
    expect(await count("SELECT COUNT(*) AS n FROM transactions")).toBe(1);
  });
  it("foreign currency uses the ECB rate (fx_source ecb)", async () => {
    const d = deps({ fetch: (async () => Response.json({ rates: { SGD: 0.0089 } })) as typeof fetch });
    await handleEmail(inbound(fixture("synthetic-dbs-foreign")), e, d);
    expect(await env.DB.prepare("SELECT currency, amount_minor, amount_sgd_minor, fx_source FROM transactions").first()).toEqual({ currency: "JPY", amount_minor: 1200, amount_sgd_minor: 1068, fx_source: "ecb" });
  });
  it("HTML-only, sentence and Citi layouts all capture", async () => {
    for (const n of ["synthetic-dbs-html", "synthetic-dbs-sentence", "synthetic-citi-sgd", "synthetic-citi-labeled"]) {
      expect((await handleEmail(inbound(fixture(n)), e, deps())).action).toBe("captured");
    }
    expect(await count("SELECT COUNT(*) AS n FROM transactions")).toBe(4);
    expect(await count("SELECT COUNT(*) AS n FROM raw_ingest WHERE source = 'email:citi'")).toBe(2);
  });
  it("categorises through the same pipeline (rule wins)", async () => {
    await app(deps()).request("/api/rules", json("POST", { pattern: "YA KUN", match_type: "prefix", category_id: "coffee" }), e);
    await handleEmail(inbound(fixture("synthetic-dbs-sgd")), e, deps());
    expect(await env.DB.prepare("SELECT category_id, category_source FROM transactions").first()).toEqual({ category_id: "coffee", category_source: "rule" });
  });
});

describe("email handler: LLM fallback and failures", () => {
  const ai = { run: async () => ({ response: '{"amount":"14.50","currency":"SGD","merchant":"Ya Kun","card_last4":"1234","datetime":"2026-10-18T12:00:00+08:00"}' }) };
  it("regex miss -> AI extraction, saved as needs_review", async () => {
    const out = await handleEmail(inbound(fixture("synthetic-dbs-garbled")), e, deps({ ai }));
    expect(out).toMatchObject({ action: "captured", via: "ai", status: "needs_review" });
    const rv = await (await app(deps()).request("/api/review", undefined, e)).json<{ items: { merchant: string }[] }>();
    expect(rv.items.map((i) => i.merchant)).toEqual(["YA KUN"]);
  });
  it("rejects nonsense from the model; no AI at all -> failed raw_ingest shown in the inbox with its text", async () => {
    const bad = { run: async () => ({ response: '{"amount":"lots","currency":"SGD","merchant":"X"}' }) };
    expect((await handleEmail(inbound(fixture("synthetic-dbs-garbled")), e, deps({ ai: bad }))).action).toBe("failed");
    expect(await count("SELECT COUNT(*) AS n FROM transactions")).toBe(0);
    const rv = await (await app(deps()).request("/api/review", undefined, e)).json<{ failed: { payload: string }[] }>();
    expect(rv.failed).toHaveLength(1);
    expect(rv.failed[0]!.payload).toContain("fourteen fifty");
  });
});

describe("Apple Pay <-> email dedup/merge (spec §4.3)", () => {
  const tap = { amount: "S$14.50", merchant: "SQ *YA KUN KAYA TOAST", card: "DBS Altitude Visa", ts: "2026-10-14T12:12:00+08:00" };

  it("Apple Pay first, then the email: ONE transaction, email amount + Apple Pay timestamp, confirmed, both raws linked", async () => {
    await addCard();
    const a = await (await applePay(deps(), { ...tap, amount: "S$14.49" })).json<{ id: string }>(); // tap amount slightly off
    expect(await env.DB.prepare("SELECT status FROM transactions").first()).toEqual({ status: "pending" });
    const out = await handleEmail(inbound(fixture("synthetic-dbs-sgd")), e, deps());
    expect(out).toMatchObject({ action: "captured", merged: true, transactionId: a.id });
    expect(await count("SELECT COUNT(*) AS n FROM transactions")).toBe(1);
    const t = await env.DB.prepare("SELECT amount_minor, amount_sgd_minor, status, occurred_at, source FROM transactions").first();
    expect(t).toEqual({ amount_minor: 1450, amount_sgd_minor: 1450, status: "confirmed", occurred_at: "2026-10-14T04:12:00.000Z", source: "applepay" });
    expect(await count(`SELECT COUNT(*) AS n FROM raw_ingest WHERE transaction_id = '${a.id}'`)).toBe(2);
  });

  it("email first, then Apple Pay: still one transaction, Apple Pay's timestamp, the email's amount", async () => {
    await addCard();
    await handleEmail(inbound(fixture("synthetic-dbs-sgd")), e, deps());
    const res = await applePay(deps(), { ...tap, amount: "S$14.49" });
    expect(res.status).toBe(200); // merged
    expect((await res.json<{ merged: boolean }>()).merged).toBe(true);
    expect(await count("SELECT COUNT(*) AS n FROM transactions")).toBe(1);
    expect(await env.DB.prepare("SELECT amount_minor, status, occurred_at FROM transactions").first()).toEqual({ amount_minor: 1450, status: "confirmed", occurred_at: "2026-10-14T04:12:00.000Z" });
  });

  it("an Apple Pay user category survives the merge", async () => {
    await addCard();
    const a = await (await applePay(deps(), tap)).json<{ id: string }>();
    await app(deps()).request(`/api/transactions/${a.id}`, json("PATCH", { category_id: "coffee" }), e);
    await handleEmail(inbound(fixture("synthetic-dbs-sgd")), e, deps());
    expect(await env.DB.prepare("SELECT category_id, category_source FROM transactions").first()).toEqual({ category_id: "coffee", category_source: "user" });
  });

  it("different card, different amount, or outside 30 minutes are two separate purchases", async () => {
    await addCard();
    await applePay(deps(), { ...tap, card: "Citi Something" }); // card unknown -> not the same card
    await applePay(deps(), { ...tap, amount: "S$40.00", ts: "2026-10-14T12:11:00+08:00" });
    await applePay(deps(), { ...tap, ts: "2026-10-14T13:00:00+08:00" });
    const before = await count("SELECT COUNT(*) AS n FROM transactions");
    const out = await handleEmail(inbound(fixture("synthetic-dbs-sgd")), e, deps());
    expect(out).toMatchObject({ merged: false });
    expect(await count("SELECT COUNT(*) AS n FROM transactions")).toBe(before + 1);
  });

  it("two real purchases from the SAME source are never merged", async () => {
    await addCard();
    await applePay(deps(), tap);
    await applePay(deps(), { ...tap, ts: "2026-10-14T12:14:00+08:00" });
    expect(await count("SELECT COUNT(*) AS n FROM transactions")).toBe(2);
  });

  it("an already-merged transaction isn't matched again by a second copy of the email", async () => {
    await addCard();
    await applePay(deps(), tap);
    await handleEmail(inbound(fixture("synthetic-dbs-sgd")), e, deps());
    const dup = fixture("synthetic-dbs-sgd").replace("synthetic-dbs-sgd-1@dbs.com", "other-id@dbs.com");
    const out = await handleEmail(inbound(dup), e, deps());
    expect(out).toMatchObject({ merged: false }); // a genuine second purchase as far as we can tell
  });

  it("uncertain match (card unknown on the Apple Pay side) -> separate rows + a 'Possible duplicate' card; merging keeps the Apple Pay row with the email's amount", async () => {
    await addCard();
    const a = await (await applePay(deps(), { ...tap, card: "" , amount: "S$14.50"})).json<{ id: string }>();
    const out = await handleEmail(inbound(fixture("synthetic-dbs-sgd")), e, deps());
    expect(out).toMatchObject({ merged: false });
    expect(await count("SELECT COUNT(*) AS n FROM transactions")).toBe(2);
    const rv = await (await app(deps()).request("/api/review", undefined, e)).json<{ duplicates: { id: string; txn: { id: string }; other: { id: string } }[] }>();
    expect(rv.duplicates).toHaveLength(1);
    expect(rv.duplicates[0]!.other.id).toBe(a.id);
    expect((await (await app(deps()).request("/api/summary?month=2026-10", undefined, e)).json<{ reviewCount: number }>()).reviewCount).toBeGreaterThanOrEqual(1);

    const merged = await app(deps()).request(`/api/duplicates/${rv.duplicates[0]!.id}/merge`, { method: "POST" }, e);
    expect(merged.status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM transactions")).toBe(1);
    expect(await env.DB.prepare("SELECT id, status, source FROM transactions").first()).toEqual({ id: a.id, status: "confirmed", source: "applepay" });
    expect(await count(`SELECT COUNT(*) AS n FROM raw_ingest WHERE transaction_id = '${a.id}'`)).toBe(2);
    expect((await (await app(deps()).request("/api/review", undefined, e)).json<{ duplicates: unknown[] }>()).duplicates).toHaveLength(0);
  });

  it("'not a duplicate' dismisses the card and keeps both rows", async () => {
    await addCard();
    await applePay(deps(), { ...tap, card: "" });
    await handleEmail(inbound(fixture("synthetic-dbs-sgd")), e, deps());
    const rv = await (await app(deps()).request("/api/review", undefined, e)).json<{ duplicates: { id: string }[] }>();
    expect((await app(deps()).request(`/api/duplicates/${rv.duplicates[0]!.id}/dismiss`, { method: "POST" }, e)).status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM transactions")).toBe(2);
    expect((await (await app(deps()).request("/api/review", undefined, e)).json<{ duplicates: unknown[] }>()).duplicates).toHaveLength(0);
  });

  it("totals never double count a merged purchase", async () => {
    await addCard();
    await applePay(deps(), tap);
    await handleEmail(inbound(fixture("synthetic-dbs-sgd")), e, deps());
    const s = await (await app(deps()).request("/api/summary?month=2026-10", undefined, e)).json<{ total: number }>();
    expect(s.total).toBe(1450);
  });
});

describe("cron", () => {
  it("promotes Apple Pay items still pending after 24h to confirmed (and not before)", async () => {
    await addCard();
    await applePay(deps(), { amount: "S$5.00", merchant: "Kopi", card: "DBS Altitude Visa" });
    const created = (await env.DB.prepare("SELECT created_at FROM transactions").first<{ created_at: string }>())!.created_at;
    const t0 = Date.parse(created);
    expect(await promoteStalePending(e, deps({ now: () => new Date(t0 + 23 * 3600_000) }))).toBe(0);
    expect(await promoteStalePending(e, deps({ now: () => new Date(t0 + 25 * 3600_000) }))).toBe(1);
    expect(await env.DB.prepare("SELECT status FROM transactions").first()).toEqual({ status: "confirmed" });
  });
  it("warns once when DBS emails go silent for 3+ days, never before the first email, and only once per silence", async () => {
    expect(await emailHealthAlerts(e, deps())).toEqual([]); // never received: no nag
    await handleEmail(inbound(fixture("synthetic-dbs-sgd")), e, deps()); // received_at = NOW
    expect(await emailHealthAlerts(e, deps({ now: () => new Date(NOW.getTime() + 2 * 86400_000) }))).toEqual([]);
    const later = deps({ now: () => new Date(NOW.getTime() + 4 * 86400_000) });
    expect(await emailHealthAlerts(e, later)).toEqual(["dbs"]);
    expect(await emailHealthAlerts(e, later)).toEqual([]);
    expect(await count("SELECT COUNT(*) AS n FROM alert_log WHERE kind = 'email_health'")).toBe(1);
  });
  it("runScheduled runs both jobs", async () => {
    await expect(runScheduled(e, deps(), "0 * * * *")).resolves.toBeUndefined();
  });
});

describe("raw_ingest viewer and setup status", () => {
  it("lists captures and shows the last email per bank", async () => {
    await handleEmail(inbound(fixture("synthetic-dbs-sgd")), e, deps());
    await handleEmail(inbound(fixture("synthetic-dbs-garbled")), e, deps());
    const list = await (await app(deps()).request("/api/raw-ingest", undefined, e)).json<{ id: string; source: string; parse_status: string }[]>();
    expect(list.map((r) => r.parse_status).sort()).toEqual(["failed", "ok"]);
    const one = await (await app(deps()).request(`/api/raw-ingest/${list[0]!.id}`, undefined, e)).json<{ payload: string }>();
    expect(one.payload).toContain("Subject:");
    const setup = await (await app(deps()).request("/api/setup", undefined, e)).json<{ email: { forward_configured: boolean; banks: Record<string, { last_at: string; failed: number }> } }>();
    expect(setup.email.forward_configured).toBe(true);
    expect(setup.email.banks.dbs).toMatchObject({ last_at: NOW.toISOString(), failed: 1 });
  });
});
