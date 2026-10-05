import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { CRON_DAILY, runScheduled } from "../src/cron";
import { _resetRateLimit } from "../src/routes/ingest";
import type { Env } from "../src/env";
import { loadSubscriptionFixedCosts, onChargeRecorded, runSubscriptionDetection } from "../src/subscriptions";
import { count, harness, json, resetDb } from "./helpers";

beforeEach(async () => { _resetRateLimit(); await resetDb(); });

const NOON = new Date("2026-10-14T04:00:00Z"); // Wed 14 Oct 2026 12:00 SGT (the harness default)
type H = ReturnType<typeof harness>;
type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const api = async (h: H, method: string, path: string, body?: unknown) => {
  const r = await h.call(path, body === undefined ? { method } : json(method, body));
  return { status: r.status, body: (await r.json()) as Obj };
};
const ok = async (h: H, method: string, path: string, body?: unknown): Promise<Obj> => {
  const r = await api(h, method, path, body);
  expect(r.status, `${method} ${path} ${JSON.stringify(r.body)}`).toBeLessThan(300);
  return r.body;
};
const outbox = async (kind: string) => (await env.DB.prepare("SELECT * FROM push_outbox WHERE kind = ? ORDER BY created_at, id").bind(kind).all<{ payload_json: string; tag: string | null; sent_at: string | null; send_after: string }>()).results;
const bodies = async (kind: string) => (await outbox(kind)).map((r) => JSON.parse(r.payload_json).body as string);
const events = async (id: string, kind?: string) => (await env.DB.prepare(`SELECT kind, data_json FROM subscription_events WHERE subscription_id = ? ${kind ? "AND kind = ?" : ""} ORDER BY rowid`).bind(...(kind ? [id, kind] : [id])).all<{ kind: string; data_json: string }>()).results.map((r) => ({ kind: r.kind, data: JSON.parse(r.data_json) as Obj }));

/** A harness with the nudge limit lifted so it never gets in the way of what a test counts. */
async function setup(now: Date = NOON, rates: Record<string, number> = {}) {
  const h = harness({ now, rates });
  await ok(h, "PUT", "/api/settings", { nudge_daily_limit: 20 });
  return h;
}
const charge = (h: H, merchant: string, amount_minor: number, date: string, o: Obj = {}) =>
  ok(h, "POST", "/api/transactions", { amount_minor, category_id: "subscriptions", merchant, occurred_at: `${date}T04:00:00Z`, ...o });
const addSub = (h: H, o: Obj = {}) => ok(h, "POST", "/api/subscriptions", { name: "Netflix", catalogue_key: "netflix", amount_minor: 1998, cycle: "monthly", next_renewal: "2026-10-20", ...o });
const sub = async (id: string) => (await env.DB.prepare("SELECT * FROM subscriptions WHERE id = ?").bind(id).first<Obj>())!;
const list = async (h: H) => (await ok(h, "GET", "/api/subscriptions")) as { items: Obj[]; totals: Obj; monthly_total: number; confirmed_total: number; catalogue: Obj[] };

describe("migration 0008: recurring -> subscriptions", () => {
  it("the recurring table is gone, transactions.recurring_id points at subscriptions, new columns and events table exist", async () => {
    const tables = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>()).results.map((r) => r.name);
    expect(tables).not.toContain("recurring");
    expect(tables).toContain("subscriptions");
    expect(tables).toContain("subscription_events");
    const fks = (await env.DB.prepare("PRAGMA foreign_key_list('transactions')").all<{ from: string; table: string }>()).results;
    expect(fks.find((f) => f.from === "recurring_id")?.table).toBe("subscriptions");
    expect(fks.some((f) => f.table === "recurring")).toBe(false);
    const cols = (await env.DB.prepare("PRAGMA table_info('subscriptions')").all<{ name: string }>()).results.map((r) => r.name);
    for (const c of ["id", "name", "catalogue_key", "amount_minor", "currency", "cycle", "next_renewal", "account_id", "category_id", "source", "status", "trial_ends", "merchant_pattern", "last_charged", "created_at", "expected_sgd_minor", "pending_price_sgd_minor"]) expect(cols).toContain(c);
    for (const c of ["merchant", "active", "confirmed_by_user", "cadence", "next_expected", "expected_amount_sgd_minor"]) expect(cols).not.toContain(c);
  });

  it("rows shaped like migrated data keep their ids, stay linked to their transactions and show up in the list", async () => {
    const h = await setup();
    // what the migration produces for a confirmed Phase 5 row (id kept, status 'active') and a dismissed one
    await env.DB.prepare("INSERT INTO subscriptions (id, name, merchant_pattern, amount_minor, currency, cycle, next_renewal, expected_sgd_minor, category_id, source, status, created_at) VALUES ('old1','NETFLIX','NETFLIX',1998,'SGD','monthly','2026-10-12',1998,'subscriptions','detected','active','2026-10-01T00:00:00Z'), ('old2','GYM','GYM',9000,'SGD','monthly','2026-10-12',9000,'hobbies','detected','dismissed','2026-10-01T00:00:00Z')").run();
    await env.DB.prepare("INSERT INTO transactions (id, occurred_at, amount_minor, currency, amount_sgd_minor, status, source, merchant, category_id, recurring_id, created_at, updated_at) VALUES ('t1','2026-09-12T04:00:00Z',1998,'SGD',1998,'confirmed','manual','NETFLIX','subscriptions','old1','x','x')").run();
    const l = await list(h);
    expect(l.items.map((i) => i.id)).toEqual(["old1"]); // dismissed rows are not listed
    expect(l.items[0]).toMatchObject({ status: "active", merchant: "NETFLIX", expected_amount_sgd_minor: 1998, confirmed_by_user: 1, active: 1, next_expected: "2026-10-12", monthly_equivalent: 1998 });
    expect(await count("SELECT COUNT(*) AS n FROM transactions WHERE recurring_id = 'old1'")).toBe(1);
    // the dismissed row is still never resurrected by detection
    await charge(h, "Gym", 9000, "2026-08-12");
    await charge(h, "Gym", 9000, "2026-09-12");
    expect(await runSubscriptionDetection(h.e, h.deps)).toEqual({ added: 0, updated: 0 });
  });
});

describe("candidate detection", () => {
  it("2 consecutive monthly charges -> one candidate and one push; a single charge is nothing; a second scan adds no push", async () => {
    const h = await setup();
    await charge(h, "Spotify", 1198, "2026-09-12");
    expect(await runSubscriptionDetection(h.e, h.deps)).toEqual({ added: 0, updated: 0 });
    await charge(h, "Spotify", 1198, "2026-08-12");
    await charge(h, "Starbucks", 450, "2026-09-12"); // a one-off
    expect(await ok(h, "POST", "/api/subscriptions/detect")).toEqual({ added: 1, updated: 0 });
    const l = await list(h);
    expect(l.items).toHaveLength(1);
    expect(l.items[0]).toMatchObject({ name: "Spotify", status: "candidate", source: "detected", amount_minor: 1198, currency: "SGD", cycle: "monthly", next_renewal: "2026-10-12", merchant_pattern: "SPOTIFY", expected_sgd_minor: 1198, category_id: "subscriptions" });
    expect(l.monthly_total).toBe(1198); // candidates count in monthly_total only
    expect(l.confirmed_total).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM transactions WHERE recurring_id IS NOT NULL")).toBe(2);
    expect(await bodies("subscription_candidate")).toEqual(["New subscription? Spotify S$11.98/month"]);
    expect((await outbox("subscription_candidate"))[0]).toMatchObject({ tag: "sub-candidate" });

    expect(await runSubscriptionDetection(h.e, h.deps)).toEqual({ added: 0, updated: 1 });
    expect(await count("SELECT COUNT(*) AS n FROM push_outbox WHERE kind = 'subscription_candidate'")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM subscriptions")).toBe(1);
  });

  it("several new candidates are batched into ONE push; the daily cron runs the scan", async () => {
    const h = await setup();
    for (const d of ["2026-08-12", "2026-09-12"]) { await charge(h, "Netflix", 1998, d); await charge(h, "Spotify", 1198, d); }
    await runScheduled(h.e, h.deps, CRON_DAILY);
    expect(await count("SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'candidate'")).toBe(2);
    expect(await bodies("subscription_candidate")).toEqual(["New subscriptions? Netflix S$19.98/month, Spotify S$11.98/month"]);
  });

  it("confirm -> active; dismiss unlinks the transactions and is never resurrected; a cancelled one stays cancelled", async () => {
    const h = await setup();
    for (const d of ["2026-08-12", "2026-09-12"]) { await charge(h, "Netflix", 1998, d); await charge(h, "Spotify", 1198, d); }
    await runSubscriptionDetection(h.e, h.deps);
    const [netflix, spotify] = (await list(h)).items;
    const r = await ok(h, "POST", `/api/subscriptions/${netflix!.id}/confirm`);
    expect(r.item).toMatchObject({ status: "active", confirmed_by_user: 1 });
    expect((await list(h)).confirmed_total).toBe(1998);

    await ok(h, "POST", `/api/subscriptions/${spotify!.id}/dismiss`);
    expect((await list(h)).items.map((i) => i.name)).toEqual(["Netflix"]);
    expect(await count("SELECT COUNT(*) AS n FROM transactions WHERE recurring_id IS NOT NULL")).toBe(2); // Netflix's only
    expect(await runSubscriptionDetection(h.e, h.deps)).toEqual({ added: 0, updated: 1 }); // Netflix refreshed; Spotify not resurrected
    expect(await count("SELECT COUNT(*) AS n FROM subscriptions")).toBe(2);

    await ok(h, "POST", `/api/subscriptions/${netflix!.id}/cancelled`);
    expect(await runSubscriptionDetection(h.e, h.deps)).toEqual({ added: 0, updated: 0 }); // charges before the cancellation don't bring it back
    expect(await count("SELECT COUNT(*) AS n FROM subscriptions")).toBe(2);
    expect((await api(h, "POST", "/api/subscriptions/nope/confirm")).status).toBe(404);
  });
});

describe("merging detected and manual entries (no duplicates)", () => {
  it("manual first, then detection: one row, pattern kept, transactions linked, no candidate push", async () => {
    const h = await setup();
    const s = await addSub(h, { amount_minor: 2000 }); // catalogue pattern NETFLIX, price a bit off
    expect(s).toMatchObject({ merged: false, status: "active", source: "manual", merchant_pattern: "NETFLIX", expected_sgd_minor: 2000, category_id: "subscriptions" });
    for (const d of ["2026-08-12", "2026-09-12"]) await charge(h, "Netflix", 1998, d);
    expect(await runSubscriptionDetection(h.e, h.deps)).toEqual({ added: 0, updated: 1 });
    expect(await count("SELECT COUNT(*) AS n FROM subscriptions")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM push_outbox WHERE kind = 'subscription_candidate'")).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM transactions WHERE recurring_id = '${s.id}'`)).toBe(2);
    // manual values are not overwritten by detection; the charge hook has moved the schedule (charges were recorded after the manual entry)
    expect(await sub(s.id)).toMatchObject({ source: "manual", status: "active", expected_sgd_minor: 2000, last_charged: "2026-09-12", next_renewal: "2026-10-12" });
  });

  it("a manual entry without a pattern gets the detected merchant as its pattern", async () => {
    const h = await setup();
    const s = await addSub(h, { name: "Spotify Premium", catalogue_key: null, amount_minor: 1198, merchant_pattern: null });
    expect(s.merchant_pattern).toBeNull();
    for (const d of ["2026-08-12", "2026-09-12"]) await charge(h, "Spotify", 1198, d);
    await runSubscriptionDetection(h.e, h.deps); // matched by similar name + amount
    expect(await count("SELECT COUNT(*) AS n FROM subscriptions")).toBe(1);
    expect((await sub(s.id)).merchant_pattern).toBe("SPOTIFY");
  });

  it("detection first, then manual add: merged into the candidate, which becomes a manual active entry", async () => {
    const h = await setup();
    for (const d of ["2026-08-12", "2026-09-12"]) await charge(h, "Netflix", 1998, d);
    await runSubscriptionDetection(h.e, h.deps);
    const cand = (await list(h)).items[0]!;
    expect(cand.status).toBe("candidate");
    const merged = await ok(h, "POST", "/api/subscriptions", { name: "Netflix Standard", catalogue_key: "netflix", amount_minor: 1998, cycle: "monthly", next_renewal: "2026-10-12" });
    expect(merged).toMatchObject({ merged: true, id: cand.id, source: "manual", status: "active", name: "Netflix Standard" });
    expect(await count("SELECT COUNT(*) AS n FROM subscriptions")).toBe(1);
    expect(await count(`SELECT COUNT(*) AS n FROM transactions WHERE recurring_id = '${cand.id}'`)).toBe(2);
  });

  it("two manual subscriptions behind one card merchant (Apple) stay separate", async () => {
    const h = await setup();
    const a = await addSub(h, { name: "iCloud+", catalogue_key: "icloud", amount_minor: 1298 });
    const b = await addSub(h, { name: "Apple Music", catalogue_key: null, merchant_pattern: "APPLE.COM/BILL", amount_minor: 1098 });
    expect(b.merged).toBe(false);
    expect(b.id).not.toBe(a.id);
    // the charge goes to the subscription with the closest expected amount
    await charge(h, "APPLE.COM/BILL", 1098, "2026-10-14");
    expect(await count(`SELECT COUNT(*) AS n FROM transactions WHERE recurring_id = '${b.id}'`)).toBe(1);
  });
});

describe("manual add / edit validation", () => {
  it("validates input, converts foreign prices, 422 without a rate, defaults from the catalogue", async () => {
    const h = await setup(NOON, { USD: 1.3 });
    expect((await api(h, "POST", "/api/subscriptions", { name: "x", amount_minor: 0, next_renewal: "2026-10-20" })).status).toBe(400);
    expect((await api(h, "POST", "/api/subscriptions", { name: "x", amount_minor: 500, next_renewal: "2026-13-40" })).status).toBe(400);
    expect((await api(h, "POST", "/api/subscriptions", { name: "x", amount_minor: 500, next_renewal: "2026-10-20", catalogue_key: "nope" })).status).toBe(400);
    expect((await api(h, "POST", "/api/subscriptions", { name: "x", amount_minor: 500, next_renewal: "2026-10-20", status: "trial" })).status).toBe(400); // trial needs trial_ends
    expect((await api(h, "POST", "/api/subscriptions", { name: "x", amount_minor: 500, next_renewal: "2026-10-20", category_id: "nope" })).status).toBe(400);

    const usd = await addSub(h, { name: "ChatGPT", catalogue_key: "chatgpt", amount_minor: 2000, currency: "usd" });
    expect(usd).toMatchObject({ currency: "USD", amount_minor: 2000, expected_sgd_minor: 2600, merchant_pattern: "OPENAI", monthly_equivalent: 2600 });
    expect((await api(h, "POST", "/api/subscriptions", { name: "Foo", amount_minor: 900, currency: "EUR", next_renewal: "2026-10-20" })).status).toBe(422);
    const eur = await ok(h, "POST", "/api/subscriptions", { name: "Foo", amount_minor: 900, currency: "EUR", next_renewal: "2026-10-20", expected_sgd_minor: 1300 });
    expect(eur).toMatchObject({ expected_sgd_minor: 1300, category_id: "subscriptions", cycle: "monthly" });

    const gym = await ok(h, "POST", "/api/subscriptions", { name: "Gym", catalogue_key: "gym", amount_minor: 9000, next_renewal: "2026-10-30" });
    expect(gym).toMatchObject({ category_id: "hobbies", merchant_pattern: null, cancel_url: null });
    const patched = await ok(h, "PATCH", `/api/subscriptions/${gym.id}`, { amount_minor: 9500, next_renewal: "2026-11-01", merchant_pattern: "Pure Gym" });
    expect(patched).toMatchObject({ amount_minor: 9500, expected_sgd_minor: 9500, next_renewal: "2026-11-01", merchant_pattern: "PURE GYM" });
    expect((await api(h, "PATCH", "/api/subscriptions/nope", { name: "x" })).status).toBe(404);
    expect((await api(h, "PATCH", `/api/subscriptions/${gym.id}`, { cycle: "daily" })).status).toBe(400);
    const cancelled = await ok(h, "PATCH", `/api/subscriptions/${gym.id}`, { status: "cancelled" });
    expect(cancelled.status).toBe("cancelled");
    expect(await events(gym.id, "cancelled")).toEqual([{ kind: "cancelled", data: { intent: false } }]);
  });
});

describe("charge hook and price changes", () => {
  it("links a matching charge, moves last_charged / next_renewal (SGT), logs an event", async () => {
    const h = await setup();
    const s = await addSub(h, { next_renewal: "2026-10-12" });
    const t = await charge(h, "Netflix", 1998, "2026-10-12", { occurred_at: "2026-10-12T17:30:00Z" }); // 13 Oct 01:30 SGT
    expect(await count(`SELECT COUNT(*) AS n FROM transactions WHERE id = '${t.id}' AND recurring_id = '${s.id}'`)).toBe(1);
    expect(await sub(s.id)).toMatchObject({ last_charged: "2026-10-13", next_renewal: "2026-11-13", pending_price_sgd_minor: null });
    expect(await events(s.id)).toEqual([{ kind: "charged", data: { txn_id: t.id, amount_sgd: 1998 } }]);
    // a refund and an unrelated merchant are ignored
    await charge(h, "Netflix", 1998, "2026-10-14", { is_refund: true });
    await charge(h, "Starbucks", 450, "2026-10-14");
    expect(await count("SELECT COUNT(*) AS n FROM subscription_events")).toBe(1);
    // a back-dated entry is linked but doesn't move the schedule
    await charge(h, "Netflix", 1998, "2026-09-01");
    expect(await sub(s.id)).toMatchObject({ last_charged: "2026-10-13", next_renewal: "2026-11-13" });
    expect(await count("SELECT COUNT(*) AS n FROM subscription_events")).toBe(1);
  });

  it("threshold: S$19.98 -> S$20.48 is no change; -> S$20.49 flags it and pushes the text", async () => {
    const h = await setup();
    const s = await addSub(h, { next_renewal: "2026-10-14" });
    await charge(h, "Netflix", 2048, "2026-10-14");
    expect((await sub(s.id)).pending_price_sgd_minor).toBeNull();
    expect(await outbox("subscription_price")).toHaveLength(0);
    expect((await list(h)).items[0]!.flags.price_change).toBe(false);

    await charge(h, "Netflix", 2049, "2026-10-14");
    expect((await sub(s.id)).pending_price_sgd_minor).toBe(2049);
    expect(await bodies("subscription_price")).toEqual(["Netflix went from S$19.98 to S$20.49 (+S$6.12/year)."]);
    expect((await outbox("subscription_price"))[0]).toMatchObject({ tag: `sub-price-${s.id}` });
    expect(JSON.parse((await outbox("subscription_price"))[0]!.payload_json).url).toBe("/subscriptions");
    expect(await events(s.id, "price_change")).toEqual([{ kind: "price_change", data: { from: 1998, to: 2049, txn_id: expect.any(String) } }]);
    expect((await list(h)).items[0]!.flags.price_change).toBe(true);
  });

  it("a foreign-currency charge gets an extra 3% before it counts as a change", async () => {
    const h = await setup();
    const s = await addSub(h, { next_renewal: "2026-10-14" });
    // threshold = 50 + ceil(3% of 1998 = 59.94) = 110: S$21.08 is the edge
    await charge(h, "Netflix", 1620, "2026-10-14", { currency: "USD", amount_sgd_minor: 2108 });
    expect((await sub(s.id)).pending_price_sgd_minor).toBeNull();
    await charge(h, "Netflix", 1630, "2026-10-14", { currency: "USD", amount_sgd_minor: 2109 });
    expect((await sub(s.id)).pending_price_sgd_minor).toBe(2109);
    expect(await outbox("subscription_price")).toHaveLength(1);
  });

  it("accept new price updates the expected amount; review keeps it; both clear the flag", async () => {
    const h = await setup();
    const s = await addSub(h, { next_renewal: "2026-10-14" });
    expect((await api(h, "POST", `/api/subscriptions/${s.id}/accept-price`)).status).toBe(400); // nothing pending
    await charge(h, "Netflix", 2298, "2026-10-14");
    const accepted = await ok(h, "POST", `/api/subscriptions/${s.id}/accept-price`);
    expect(accepted.item).toMatchObject({ expected_sgd_minor: 2298, amount_minor: 2298, pending_price_sgd_minor: null, flags: { price_change: false } });
    expect(await events(s.id, "price_change")).toHaveLength(2);
    await charge(h, "Netflix", 2298, "2026-10-14"); // the new price is now the expectation: no new flag
    expect((await sub(s.id)).pending_price_sgd_minor).toBeNull();

    await charge(h, "Netflix", 2598, "2026-10-14");
    expect((await sub(s.id)).pending_price_sgd_minor).toBe(2598);
    await charge(h, "Netflix", 2598, "2026-10-14"); // the same flagged price again does not push again
    expect(await outbox("subscription_price")).toHaveLength(2);
    const reviewed = await ok(h, "POST", `/api/subscriptions/${s.id}/review-price`);
    expect(reviewed.item).toMatchObject({ expected_sgd_minor: 2298, pending_price_sgd_minor: null });
  });

  it("a trial that is charged on/after trial_ends becomes active; the hook never throws", async () => {
    const h = await setup();
    const t = await addSub(h, { name: "ChatGPT", catalogue_key: "chatgpt", amount_minor: 2800, next_renewal: "2026-10-15", trial_ends: "2026-10-15" });
    expect(t.status).toBe("trial");
    expect(t.flags.trial_ending).toBe(true); // 14 Oct is within 2 days of 15 Oct
    expect((await list(h)).totals).toMatchObject({ monthly: 0, count: 0 }); // a trial is not charging yet
    await charge(h, "OpenAI", 2800, "2026-10-15");
    expect(await sub(t.id)).toMatchObject({ status: "active", last_charged: "2026-10-15", next_renewal: "2026-11-15" });
    expect((await list(h)).totals).toMatchObject({ monthly: 2800, count: 1 });

  });

  it("never throws: a failing database inside the hook is swallowed", async () => {
    const h = await setup();
    const broken = { DB: { prepare: () => { throw new Error("db down"); } } } as unknown as Env;
    await expect(onChargeRecorded(broken, h.deps, { id: "t", merchant: "NETFLIX", occurred_at: NOON.toISOString(), amount_minor: 1, currency: "SGD", amount_sgd_minor: 1, is_refund: 0, status: "confirmed" })).resolves.toBeUndefined();
  });
});

describe("missing charge flag", () => {
  it("more than 7 days late -> quiet flag, no push, one 'missing' event per expected date", async () => {
    const h = await setup(); // today 14 Oct
    const late = await addSub(h, { next_renewal: "2026-10-06" }); // 8 days late
    const fine = await addSub(h, { name: "Spotify", catalogue_key: "spotify", amount_minor: 1198, next_renewal: "2026-10-07" }); // exactly 7 days: not yet
    const l = await list(h);
    expect(l.items.find((i) => i.id === late.id)!.flags.missing).toBe(true);
    expect(l.items.find((i) => i.id === fine.id)!.flags.missing).toBe(false);
    await runScheduled(h.e, h.deps, CRON_DAILY);
    await runScheduled(h.e, h.deps, CRON_DAILY);
    expect(await events(late.id, "missing")).toEqual([{ kind: "missing", data: { expected: "2026-10-06" } }]);
    expect(await events(fine.id, "missing")).toEqual([]);
    expect(await count("SELECT COUNT(*) AS n FROM push_outbox WHERE kind LIKE 'subscription_%' AND kind != 'subscription_usage'")).toBe(0);
    // a charge arrives: flag gone
    await charge(h, "Netflix", 1998, "2026-10-14");
    expect((await list(h)).items.find((i) => i.id === late.id)!.flags.missing).toBe(false);
  });
});

describe("reminders from the daily cron (02:00 SGT)", () => {
  const MON_12 = new Date("2026-10-11T18:00:00Z"); // Mon 12 Oct 02:00 SGT
  const TUE_13 = new Date("2026-10-12T18:00:00Z"); // Tue 13 Oct 02:00 SGT
  const WED_14 = new Date("2026-10-13T18:00:00Z"); // Wed 14 Oct 02:00 SGT

  it("trial ending Thu 15 Oct: Mon 12 Oct sends nothing, Tue 13 Oct sends once; held for 08:00 by the quiet hours", async () => {
    const h = await setup(MON_12);
    const t = await addSub(h, { name: "ChatGPT", catalogue_key: "chatgpt", amount_minor: 2800, next_renewal: "2026-10-15", trial_ends: "2026-10-15" });
    await runScheduled(h.e, h.deps, CRON_DAILY);
    expect(await outbox("subscription_trial")).toHaveLength(0);

    h.setNow(TUE_13);
    await runScheduled(h.e, h.deps, CRON_DAILY);
    expect(await bodies("subscription_trial")).toEqual(["ChatGPT trial ends Thu — S$28/mo after. Keep / Cancel"]);
    const row = (await outbox("subscription_trial"))[0]!;
    expect(row.tag).toBe(`sub-trial-${t.id}`);
    expect(row.sent_at).toBeNull(); // 02:00 SGT is in quiet hours
    expect(row.send_after).toBe("2026-10-13T00:00:00.000Z"); // 08:00 SGT
    expect(JSON.parse(row.payload_json).url).toBe("/subscriptions");

    h.setNow(WED_14);
    await runScheduled(h.e, h.deps, CRON_DAILY);
    await runScheduled(h.e, h.deps, CRON_DAILY);
    expect(await outbox("subscription_trial")).toHaveLength(1); // once per trial end
    expect(await events(t.id, "trial_reminder")).toHaveLength(1);
  });

  it("annual renewals: a reminder from 7 days before, once", async () => {
    const h = await setup(new Date("2026-10-23T18:00:00Z")); // Sat 24 Oct 02:00 SGT: 8 days before 1 Nov
    const s = await addSub(h, { name: "iCloud+", catalogue_key: "icloud", amount_minor: 2990, cycle: "yearly", next_renewal: "2026-11-01" });
    await runScheduled(h.e, h.deps, CRON_DAILY);
    expect(await outbox("subscription_renewal")).toHaveLength(0);
    h.setNow(new Date("2026-10-24T18:00:00Z")); // Sun 25 Oct 02:00 SGT: 7 days before
    await runScheduled(h.e, h.deps, CRON_DAILY);
    await runScheduled(h.e, h.deps, CRON_DAILY);
    expect(await bodies("subscription_renewal")).toEqual(["iCloud+ renews on 1 Nov: S$29.90"]);
    expect((await list(h)).items[0]!.flags.renewal_soon).toBe(true);
    expect(await events(s.id, "renewal_reminder")).toHaveLength(1);
    // monthly subscriptions get no renewal reminder
    await addSub(h, { name: "Spotify", catalogue_key: "spotify", amount_minor: 1198, next_renewal: "2026-10-28" });
    await runScheduled(h.e, h.deps, CRON_DAILY);
    expect(await outbox("subscription_renewal")).toHaveLength(1);
  });

  it("quarterly 'Still using?': one batched push per quarter, only when there are active subscriptions", async () => {
    const h = await setup(new Date("2026-10-13T18:00:00Z")); // Wed 14 Oct 02:00 SGT, Q4
    await runScheduled(h.e, h.deps, CRON_DAILY); // nothing active yet: nothing sent, nothing consumed
    expect(await outbox("subscription_usage")).toHaveLength(0);
    await addSub(h);
    await addSub(h, { name: "Spotify", catalogue_key: "spotify", amount_minor: 1198 });
    await addSub(h, { name: "iCloud+", catalogue_key: "icloud", amount_minor: 1298 });
    await addSub(h, { name: "Free trial", catalogue_key: null, merchant_pattern: null, amount_minor: 999, trial_ends: "2026-12-01" }); // trials are not asked about
    await runScheduled(h.e, h.deps, CRON_DAILY);
    await runScheduled(h.e, h.deps, CRON_DAILY);
    expect(await bodies("subscription_usage")).toEqual(["Still using these? Netflix, iCloud+, Spotify — Keep / Cancel"]);
    expect(JSON.parse((await outbox("subscription_usage"))[0]!.payload_json).url).toBe("/subscriptions?check=1");

    h.setNow(new Date("2026-12-30T18:00:00Z")); // 31 Dec 02:00 SGT, still Q4
    await runScheduled(h.e, h.deps, CRON_DAILY);
    expect(await outbox("subscription_usage")).toHaveLength(1);
    h.setNow(new Date("2027-01-01T18:00:00Z")); // 2 Jan 2027 02:00 SGT, Q1
    await runScheduled(h.e, h.deps, CRON_DAILY);
    expect(await outbox("subscription_usage")).toHaveLength(2);
  });

  it("keep / remind-later / cancel-intent record the answer; cancel-intent returns the cancel page", async () => {
    const h = await setup();
    const s = await addSub(h);
    await ok(h, "POST", `/api/subscriptions/${s.id}/keep`);
    await ok(h, "POST", `/api/subscriptions/${s.id}/remind-later`);
    const r = await ok(h, "POST", `/api/subscriptions/${s.id}/cancel-intent`);
    expect(r.cancel_url).toBe("https://www.netflix.com/cancelplan");
    expect(r.item).toMatchObject({ status: "cancel_intended", cancel_url: "https://www.netflix.com/cancelplan" });
    expect(await events(s.id)).toEqual([
      { kind: "usage_check", data: { answer: "keep" } }, { kind: "usage_check", data: { answer: "later" } }, { kind: "cancelled", data: { intent: true } },
    ]);
    // "keep" on a trial activates it
    const t = await addSub(h, { name: "ChatGPT", catalogue_key: "chatgpt", amount_minor: 2800, trial_ends: "2026-10-20" });
    expect((await ok(h, "POST", `/api/subscriptions/${t.id}/keep`)).item.status).toBe("active");
    expect((await ok(h, "POST", `/api/subscriptions/${s.id}/cancelled`)).item.status).toBe("cancelled");
  });
});

describe("GET /api/subscriptions: totals and cost in goal terms", () => {
  it("monthly equivalents for weekly / quarterly / yearly items; Essentials vs Lifestyle; candidates and cancelled excluded from totals", async () => {
    const h = await setup();
    await addSub(h, { name: "Netflix", amount_minor: 1998 }); // lifestyle (subscriptions)
    await addSub(h, { name: "Gym", catalogue_key: null, merchant_pattern: null, amount_minor: 500, cycle: "weekly", category_id: "groceries" }); // 500 x 52 / 12 = 2166.67 -> 2167, essentials
    await addSub(h, { name: "Insurance", catalogue_key: null, merchant_pattern: null, amount_minor: 3000, cycle: "quarterly", category_id: "insurance" }); // 1000, essentials
    await addSub(h, { name: "iCloud+", catalogue_key: "icloud", amount_minor: 12000, cycle: "yearly" }); // 1000, lifestyle
    const old = await addSub(h, { name: "Old", catalogue_key: null, merchant_pattern: null, amount_minor: 4000, status: "cancelled" });
    for (const d of ["2026-08-12", "2026-09-12"]) await charge(h, "Spotify", 1198, d);
    await runSubscriptionDetection(h.e, h.deps);

    const l = await list(h);
    const by = (n: string) => l.items.find((i) => i.name === n)!;
    expect(by("Gym")).toMatchObject({ monthly_equivalent: 2167, yearly_equivalent: 26000, group_id: "essentials" });
    expect(by("Insurance")).toMatchObject({ monthly_equivalent: 1000, yearly_equivalent: 12000 });
    expect(by("iCloud+")).toMatchObject({ monthly_equivalent: 1000, yearly_equivalent: 12000, group_id: "lifestyle" });
    expect(by("Netflix")).toMatchObject({ monthly_equivalent: 1998, yearly_equivalent: 23976, goal_impact: null });
    expect(l.totals).toEqual({ monthly: 1998 + 2167 + 1000 + 1000, yearly: 23976 + 26000 + 12000 + 12000, essentials: 3167, lifestyle: 2998, count: 4 });
    expect(l.confirmed_total).toBe(6165);
    expect(l.monthly_total).toBe(6165 + 1198); // + the Spotify candidate
    expect(by("Old").status).toBe("cancelled");
    expect(old.id).toBe(by("Old").id);
    expect(l.catalogue.map((c) => c.key)).toContain("netflix");
  });

  it("each charging item carries goal impact text when there is a receiving goal", async () => {
    const h = await setup();
    await addSub(h);
    expect((await list(h)).items[0]!.goal_impact).toBeNull(); // no goals at all

    const cash = await ok(h, "POST", "/api/nw/accounts", { name: "DBS Savings", kind: "cash" });
    await ok(h, "POST", `/api/nw/accounts/${cash.id}/balances`, { amount_minor: 100000 });
    const g = await ok(h, "POST", "/api/goals", { name: "Japan trip", kind: "short", target_today_minor: 300000 });
    await ok(h, "POST", `/api/goals/${g.id}/funding`, { source_type: "earmark", source_id: cash.id, earmark_minor: 90000 });
    await ok(h, "POST", `/api/goals/${g.id}/underspend`, { on: true }); // the receiving goal
    // saving S$900 over the last 3 months = S$300/month of pace
    await env.DB.prepare("INSERT INTO goal_snapshots (goal_id, date, value_sgd_minor) VALUES (?, '2026-07-14', 0)").bind(g.id).run();

    const item = (await list(h)).items[0]!;
    expect(item.goal_impact).toMatchObject({ goal_id: g.id, goal_name: "Japan trip", reachable_only_if_cancelled: false });
    expect(item.goal_impact.weeks_earlier).toBeGreaterThan(0);
    expect(item.goal_impact.text).toMatch(/^S\$19\.98\/mo = S\$240\/yr\. Cancelling moves 'Japan trip' \d+ weeks? earlier\.$/);
    // candidates and trials are not asked about
    await ok(h, "POST", "/api/subscriptions", { name: "Trial", amount_minor: 500, next_renewal: "2026-10-20", trial_ends: "2026-10-20" });
    expect((await list(h)).items.find((i) => i.name === "Trial")!.goal_impact).toBeNull();
  });
});

describe("fixed costs for the plan (feature P)", () => {
  it("loadSubscriptionFixedCosts: monthly equivalents plus a set-aside for yearly ones, charging subscriptions only", async () => {
    const h = await setup();
    await addSub(h, { name: "Netflix", amount_minor: 1998 });
    await addSub(h, { name: "Weekly", catalogue_key: null, merchant_pattern: null, amount_minor: 500, cycle: "weekly" });
    await addSub(h, { name: "iCloud+", catalogue_key: "icloud", amount_minor: 2990, cycle: "yearly" });
    await addSub(h, { name: "Cancel soon", catalogue_key: null, merchant_pattern: null, amount_minor: 1000, status: "cancel_intended" });
    await addSub(h, { name: "Done", catalogue_key: null, merchant_pattern: null, amount_minor: 7777, status: "cancelled" });
    await addSub(h, { name: "Trial", catalogue_key: null, merchant_pattern: null, amount_minor: 8888, trial_ends: "2026-10-30" });
    const r = await loadSubscriptionFixedCosts(env.DB);
    expect(r.fixed).toEqual({ monthly: 1998 + 2167 + 1000, setAside: 250, total: 1998 + 2167 + 1000 + 250 }); // ceil(2990 / 12) = 250
    expect(r.items.map((i) => i.name).sort()).toEqual(["Cancel soon", "Netflix", "Weekly", "iCloud+"]);
  });
});

describe("statement import goes through the charge hook", () => {
  it("an imported Netflix line is linked to the subscription and a new price is flagged", async () => {
    const h = await setup();
    const acct = (await ok(h, "POST", "/api/accounts", { name: "DBS Altitude", kind: "credit" })) as { id: string };
    const s = (await addSub(h, { merchant_pattern: "NETFLIX" })) as Obj;
    const id = String((s.item as Obj | undefined)?.id ?? s.id);
    const text = "Transaction Date,Description,Amount\n12/10/2026,NETFLIX.COM,22.98";
    const r = await api(h, "POST", "/api/import/statement", { account_id: acct.id, text, commit: true });
    expect(r.status).toBe(200);
    const txn = await env.DB.prepare("SELECT id, recurring_id FROM transactions WHERE merchant LIKE 'NETFLIX%'").first<{ id: string; recurring_id: string | null }>();
    expect(txn!.recurring_id).toBe(id);
    expect((await sub(id)).pending_price_sgd_minor).toBe(2298);
    expect(await bodies("subscription_price")).toEqual(["Netflix went from S$19.98 to S$22.98 (+S$36/year)."]);
  });
});

describe("shared card descriptors", () => {
  it("a charge on a pattern shared by several subscriptions is linked but never flagged as a price change", async () => {
    const h = await setup();
    await addSub(h, { name: "iCloud+", catalogue_key: "icloud", amount_minor: 398, merchant_pattern: "APPLE.COM/BILL" });
    await addSub(h, { name: "Apple Music", catalogue_key: null, amount_minor: 1098, merchant_pattern: "APPLE.COM/BILL" });
    await charge(h, "APPLE.COM/BILL", 1496, "2026-10-12");
    const linked = await env.DB.prepare("SELECT recurring_id FROM transactions WHERE merchant = 'APPLE.COM/BILL'").first<{ recurring_id: string | null }>();
    expect(linked!.recurring_id).not.toBeNull();
    expect(await bodies("subscription_price")).toEqual([]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE pending_price_sgd_minor IS NOT NULL").first<{ n: number }>()).toEqual({ n: 0 });
  });
});
