import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Deps } from "../src/deps";
import { _resetRateLimit } from "../src/routes/ingest";

const NOW = new Date("2026-10-14T04:00:00Z"); // 12:00 SGT, day 14 of 31
const TOKEN = "test-token-123";

interface Captured { url: string; init: RequestInit }
function setup(over: Partial<Deps> & { vapid?: boolean } = {}) {
  const calls: Captured[] = [];
  const e = { ...env, INGEST_TOKEN: TOKEN } as unknown as import("../src/env").Env;
  if (over.vapid) Object.assign(e, { VAPID_SUBJECT: "mailto:me@example.com", VAPID_PUBLIC_KEY: VAPID.pub, VAPID_PRIVATE_KEY: VAPID.priv });
  const fetchFn = over.fetch ?? (async (url: RequestInfo | URL, init?: RequestInit) => { calls.push({ url: String(url), init: init ?? {} }); return new Response("{}", { status: 201 }); });
  const app = createApp({ now: () => NOW, ...over, fetch: fetchFn as typeof fetch });
  const call = (path: string, init?: RequestInit) => app.request(path, init, e);
  return { call, calls, e };
}
const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const post = (body: unknown, headers: Record<string, string> = auth): RequestInit => ({ method: "POST", headers, body: JSON.stringify(body) });
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
const b64u = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const VAPID = { pub: "", priv: "" };
async function genKeys() {
  const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as JsonWebKey;
  const raw = new Uint8Array(65);
  raw[0] = 4;
  raw.set(unb64u(jwk.x!), 1);
  raw.set(unb64u(jwk.y!), 33);
  return { pub: b64u(raw), priv: jwk.d! };
}
async function clientSubscription(endpoint = "https://push.example.com/send/abc") {
  const kp = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const pub = new Uint8Array((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
  return { endpoint, keys: { p256dh: b64u(pub), auth: b64u(crypto.getRandomValues(new Uint8Array(16))) } };
}

beforeEach(async () => {
  _resetRateLimit();
  await env.DB.exec("DELETE FROM raw_ingest; DELETE FROM transactions; DELETE FROM merchant_rules; DELETE FROM accounts; DELETE FROM settings WHERE key = 'ingest_token'; DELETE FROM push_subscriptions; DELETE FROM fx_rates;");
  if (!VAPID.pub) Object.assign(VAPID, await genKeys());
});

describe("POST /api/ingest/applepay: auth", () => {
  it("401 without or with wrong token, 503 when no token is configured", async () => {
    const { call } = setup();
    expect((await call("/api/ingest/applepay", post({ amount: "S$1", merchant: "X", card: "" }, { "content-type": "application/json" }))).status).toBe(401);
    expect((await call("/api/ingest/applepay", post({ amount: "S$1" }, { authorization: "Bearer nope" }))).status).toBe(401);
    const none = createApp({ now: () => NOW });
    expect((await none.request("/api/ingest/applepay", post({ amount: "S$1" }), { ...env } as never)).status).toBe(503);
  });
  it("a rotated token replaces the bootstrap secret", async () => {
    const { call } = setup();
    const { token } = await (await call("/api/setup/token", { method: "POST" })).json<{ token: string }>();
    expect(token.length).toBeGreaterThan(30);
    expect((await call("/api/ingest/applepay", post({ amount: "S$1", merchant: "X" }))).status).toBe(401); // old token dead
    expect((await call("/api/ingest/applepay", post({ amount: "S$1", merchant: "X" }, { authorization: `Bearer ${token}`, "content-type": "application/json" }))).status).toBe(201);
  });
});

describe("POST /api/ingest/applepay: capture", () => {
  it("creates a pending transaction, normalises merchant, maps the Wallet card, and links raw_ingest", async () => {
    const { call } = setup();
    await call("/api/accounts", json("POST", { name: "DBS Altitude", kind: "credit", wallet_card_name: "DBS Altitude Visa" }));
    const r = await call("/api/ingest/applepay", post({ amount: "S$14.50", merchant: "SQ *YA KUN KAYA TOAST", card: "dbs altitude visa", ts: "2026-10-14T11:55:00+08:00" }));
    expect(r.status).toBe(201);
    const { id } = await r.json<{ id: string }>();
    const t = (await (await call(`/api/transactions/${id}`)).json()) as Record<string, unknown>;
    expect(t).toMatchObject({ amount_minor: 1450, currency: "SGD", amount_sgd_minor: 1450, status: "pending", source: "applepay", merchant: "YA KUN KAYA TOAST", merchant_raw: "SQ *YA KUN KAYA TOAST", occurred_at: "2026-10-14T03:55:00.000Z" });
    expect(t.account_id).toBeTruthy();
    const raw = await env.DB.prepare("SELECT transaction_id, parse_status FROM raw_ingest").first<{ transaction_id: string; parse_status: string }>();
    expect(raw).toEqual({ transaction_id: id, parse_status: "ok" });
  });

  it("pending items count in the month total (spend definition)", async () => {
    const { call } = setup();
    await call("/api/ingest/applepay", post({ amount: "S$10.00", merchant: "Mystery Shop" }));
    const s = await (await call("/api/summary?month=2026-10")).json<{ total: number; reviewCount: number }>();
    expect(s.total).toBe(1000);
    expect(s.reviewCount).toBe(1); // uncategorised -> review
  });

  it("an identical retried POST does not double count", async () => {
    const { call } = setup();
    const body = { amount: "S$5.00", merchant: "Kopi", card: "x", ts: "2026-10-14T12:00:00+08:00" };
    const a = await (await call("/api/ingest/applepay", post(body))).json<{ id: string }>();
    const bRes = await call("/api/ingest/applepay", post(body));
    expect(bRes.status).toBe(200);
    expect((await bRes.json<{ id: string }>()).id).toBe(a.id);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM transactions").first<{ n: number }>())!.n).toBe(1);
  });

  it("rejects bad payloads, keeping them as failed raw_ingest shown in the review inbox", async () => {
    const { call } = setup();
    expect((await call("/api/ingest/applepay", post({ amount: "no money here", merchant: "X" }))).status).toBe(422);
    expect((await call("/api/ingest/applepay", { method: "POST", headers: auth, body: "not json" })).status).toBe(400);
    const rv = await (await call("/api/review")).json<{ items: unknown[]; failed: { id: string; payload: string }[] }>();
    expect(rv.failed).toHaveLength(2);
    expect(rv.failed.some((f) => f.payload.includes("no money here"))).toBe(true);
    expect((await (await call("/api/summary?month=2026-10")).json<{ reviewCount: number }>()).reviewCount).toBe(2);
    expect((await call(`/api/raw-ingest/${rv.failed[0]!.id}/dismiss`, { method: "POST" })).status).toBe(200);
    expect((await (await call("/api/review")).json<{ failed: unknown[] }>()).failed).toHaveLength(1);
  });

  it("ignores a wildly wrong ts and uses server time", async () => {
    const { call } = setup();
    const { id } = await (await call("/api/ingest/applepay", post({ amount: "S$1", merchant: "A", ts: "2020-01-01T00:00:00Z" }))).json<{ id: string }>();
    expect((await (await call(`/api/transactions/${id}`)).json<{ occurred_at: string }>()).occurred_at).toBe(NOW.toISOString());
  });
});

describe("categorisation order: rule -> history -> AI -> none", () => {
  const ai = (answer: string | null) => ({ run: async () => ({ response: answer === null ? "idk" : JSON.stringify({ category_id: answer }) }) });
  const ingest = async (call: ReturnType<typeof setup>["call"], merchant: string, ts = "2026-10-14T12:00:00+08:00") =>
    (await call("/api/ingest/applepay", post({ amount: "S$3.00", merchant, ts }))).json<{ id: string; category_id: string | null; category_source: string | null }>();

  it("rule wins and counts a hit; set_excluded is honoured", async () => {
    const { call } = setup({ ai: ai("shopping") });
    await call("/api/rules", json("POST", { match_type: "prefix", pattern: "GRAB*", category_id: "grab" }));
    const r = await ingest(call, "GRAB*A-3JKD92 SINGAPORE SG");
    expect(r).toMatchObject({ category_id: "grab", category_source: "rule" });
    expect((await env.DB.prepare("SELECT hits FROM merchant_rules").first<{ hits: number }>())!.hits).toBe(1);
    await call("/api/rules", json("POST", { match_type: "exact", pattern: "DBS CARD PAYMENT", category_id: "card_payment", set_excluded: true }));
    const x = await ingest(call, "DBS CARD PAYMENT", "2026-10-14T12:01:00+08:00");
    expect((await (await call(`/api/transactions/${x.id}`)).json<{ is_excluded: number }>()).is_excluded).toBe(1);
  });

  it("history: last category the user gave this normalised merchant", async () => {
    const { call } = setup({ ai: ai("shopping") });
    const first = await ingest(call, "Ya Kun");
    expect(first.category_source).toBe("ai");
    await call(`/api/transactions/${first.id}`, json("PATCH", { category_id: "coffee" }));
    const second = await ingest(call, "SQ *YA KUN", "2026-10-14T12:30:00+08:00");
    expect(second).toMatchObject({ category_id: "coffee", category_source: "history" });
  });

  it("AI suggestion is stored as a suggestion and surfaces in the review inbox until the user confirms", async () => {
    const { call } = setup({ ai: ai("food") });
    const r = await ingest(call, "Some Noodle House");
    expect(r).toMatchObject({ category_id: "food", category_source: "ai" });
    expect((await (await call("/api/review")).json<{ items: { id: string }[] }>()).items.map((i) => i.id)).toContain(r.id);
    await call(`/api/transactions/${r.id}`, json("PATCH", { category_id: "food" })); // confirm same category
    expect((await (await call("/api/review")).json<{ items: unknown[] }>()).items).toHaveLength(0);
  });

  it("ignores an AI answer that isn't a real category, and AI outages", async () => {
    const bad = setup({ ai: ai("not_a_category") });
    expect((await ingest(bad.call, "Weird")).category_id).toBeNull();
    const boom = setup({ ai: { run: async () => { throw new Error("down"); } } });
    expect((await ingest(boom.call, "Weird 2", "2026-10-14T12:10:00+08:00")).category_id).toBeNull();
    const none = setup();
    expect((await ingest(none.call, "Weird 3", "2026-10-14T12:20:00+08:00")).category_id).toBeNull();
  });

  it("'Always use X' creates a rule that later captures follow; re-posting updates instead of duplicating", async () => {
    const { call } = setup();
    expect((await call("/api/rules", json("POST", { match_type: "exact", pattern: "Grab", category_id: "transport" }))).status).toBe(201);
    expect((await call("/api/rules", json("POST", { match_type: "exact", pattern: "GRAB", category_id: "grab" }))).status).toBe(200);
    const rules = await (await call("/api/rules")).json<{ id: string; category_id: string; pattern: string }[]>();
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ pattern: "GRAB", category_id: "grab" });
    expect((await ingest(call, "Grab")).category_id).toBe("grab");
    expect((await call(`/api/rules/${rules[0]!.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await call("/api/rules", json("POST", { match_type: "regex", pattern: "(", category_id: "grab" }))).status).toBe(400);
  });
});

describe("foreign currency", () => {
  it("converts via Frankfurter, caches the rate, and marks fx_source ecb", async () => {
    let n = 0;
    const { call } = setup({ fetch: (async (url: RequestInfo | URL) => { n++; expect(String(url)).toContain("base=JPY"); return Response.json({ rates: { SGD: 0.0089 } }); }) as typeof fetch });
    const r = await (await call("/api/ingest/applepay", post({ amount: "¥1,200", merchant: "Lawson", ts: "2026-10-14T12:00:00+08:00" }))).json<{ id: string }>();
    const t = await (await call(`/api/transactions/${r.id}`)).json<{ currency: string; amount_minor: number; amount_sgd_minor: number; fx_source: string; fx_rate: number }>();
    expect(t).toMatchObject({ currency: "JPY", amount_minor: 1200, amount_sgd_minor: 1068, fx_source: "ecb", fx_rate: 0.0089 });
    await call("/api/ingest/applepay", post({ amount: "¥500", merchant: "Lawson 2", ts: "2026-10-14T12:05:00+08:00" }));
    expect(n).toBe(1); // second one used the fx_rates cache
  });
  it("Rp 45.000 is parsed as IDR", async () => {
    const { call } = setup({ fetch: (async () => Response.json({ rates: { SGD: 0.0000835 } })) as typeof fetch });
    const { id } = await (await call("/api/ingest/applepay", post({ amount: "Rp 45.000", merchant: "Warung" }))).json<{ id: string }>();
    expect(await (await call(`/api/transactions/${id}`)).json()).toMatchObject({ currency: "IDR", amount_minor: 4_500_000, amount_sgd_minor: 376 });
  });
  it("no rate at all -> kept, needs_review, SGD amount 0 (D-13)", async () => {
    const { call } = setup({ fetch: (async () => { throw new Error("offline"); }) as typeof fetch });
    const { id } = await (await call("/api/ingest/applepay", post({ amount: "¥1,200", merchant: "Lawson" }))).json<{ id: string }>();
    expect(await (await call(`/api/transactions/${id}`)).json()).toMatchObject({ status: "needs_review", amount_sgd_minor: 0 });
  });
});

describe("web push", () => {
  it("sends the post-purchase nudge to subscribers with a VAPID header, honours the toggle, prunes dead subscriptions", async () => {
    const { call, calls } = setup({ vapid: true });
    const sub = await clientSubscription();
    expect((await call("/api/push/subscribe", json("POST", sub))).status).toBe(201);
    await call("/api/transactions", json("POST", { amount_minor: 60000, category_id: "shopping", occurred_at: "2026-10-10T04:00:00Z" }));
    await call("/api/rules", json("POST", { pattern: "YA KUN", category_id: "coffee" }));
    const r = await call("/api/ingest/applepay", post({ amount: "S$14.50", merchant: "Ya Kun", ts: "2026-10-14T12:00:00+08:00" }));
    expect(r.status).toBe(201);
    const pushCalls = calls.filter((c) => c.url === sub.endpoint);
    expect(pushCalls).toHaveLength(1);
    const headers = pushCalls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^vapid t=.+, k=.+/);
    expect(headers["content-encoding"]).toBe("aes128gcm");
    expect((pushCalls[0]!.init.body as Uint8Array).byteLength).toBeGreaterThan(50);

    // toggle off -> no push
    await call("/api/settings", json("PUT", { push_post_purchase: false }));
    await call("/api/ingest/applepay", post({ amount: "S$2.00", merchant: "Ya Kun", ts: "2026-10-14T12:10:00+08:00" }));
    expect(calls.filter((c) => c.url === sub.endpoint)).toHaveLength(1);
  });

  it("410 Gone removes the subscription", async () => {
    const { call } = setup({ vapid: true, fetch: (async () => new Response("", { status: 410 })) as typeof fetch });
    await call("/api/push/subscribe", json("POST", await clientSubscription()));
    const t = await (await call("/api/push/test", { method: "POST" })).json<{ delivered: number }>();
    expect(t.delivered).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").first<{ n: number }>())!.n).toBe(0);
  });

  it("does nothing (and doesn't fail ingest) when VAPID isn't configured", async () => {
    const { call, calls } = setup();
    await call("/api/push/subscribe", json("POST", await clientSubscription()));
    expect((await call("/api/ingest/applepay", post({ amount: "S$1.00", merchant: "A" }))).status).toBe(201);
    expect(calls).toHaveLength(0);
  });

  it("rejects non-https endpoints", async () => {
    const { call } = setup();
    expect((await call("/api/push/subscribe", json("POST", { endpoint: "http://x.test/a", keys: { p256dh: "x".repeat(20), auth: "y".repeat(20) } }))).status).toBe(400);
  });
});
