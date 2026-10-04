import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { CRON_HOURLY, runScheduled } from "../src/cron";
import { runWantsReady } from "../src/wants";
import { count, harness, json, resetDb } from "./helpers";

beforeEach(async () => { await resetDb(); });

const NOON = new Date("2026-10-14T04:00:00Z"); // Wed 14 Oct 2026 12:00 SGT
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
const want = (h: H, o: Obj = {}) => ok(h, "POST", "/api/wants", { name: "AirPods case", price_minor: 5900, ...o });
const outbox = async (kind: string) => (await env.DB.prepare("SELECT * FROM push_outbox WHERE kind = ? ORDER BY created_at").bind(kind).all<{ payload_json: string; tag: string | null }>()).results;
const goal = (h: H, o: Obj = {}) => ok(h, "POST", "/api/goals", { name: "Japan trip", emoji: "🇯🇵", kind: "short", target_today_minor: 300000, ...o });

let seq = 0;
async function insertTxn(minor: number, occurred_at: string, o: { status?: string; refund?: number } = {}) {
  const id = `w${++seq}`;
  await env.DB.prepare("INSERT INTO transactions (id, occurred_at, amount_minor, currency, amount_sgd_minor, status, source, category_id, is_refund, created_at, updated_at) VALUES (?,?,?,?,?,?,'manual','shopping',?,'x','x')")
    .bind(id, occurred_at, minor, "SGD", minor, o.status ?? "confirmed", o.refund ?? 0).run();
  return id;
}

describe("creating wants", () => {
  it("defaults the wait from the price: S$59 -> 7 days, S$350 -> 30 days", async () => {
    const h = harness({ now: NOON });
    const a = await want(h);
    expect(a).toMatchObject({ wait_days: 7, status: "waiting", currency: "SGD", price_sgd_minor: 5900, added_at: NOON.toISOString(), bought_early: 0 });
    const b = await want(h, { name: "Headphones", price_minor: 35000 });
    expect(b.wait_days).toBe(30);
    expect((await want(h, { price_minor: 20000 })).wait_days).toBe(7); // the threshold itself is not "above"
    expect((await want(h, { price_minor: 20001 })).wait_days).toBe(30);
    expect((await want(h, { price_minor: 35000, wait_days: 3 })).wait_days).toBe(3); // explicit wins
  });

  it("the long-wait threshold is a setting (default S$200) shown in /api/setup", async () => {
    const h = harness({ now: NOON });
    expect((await ok(h, "GET", "/api/setup")).wants).toEqual({ long_wait_threshold_minor: 20000 });
    await ok(h, "PUT", "/api/settings", { want_long_wait_threshold_minor: 5000 });
    expect((await ok(h, "GET", "/api/setup")).wants).toEqual({ long_wait_threshold_minor: 5000 });
    expect((await want(h, { price_minor: 5900 })).wait_days).toBe(30);
    await ok(h, "PUT", "/api/settings", { want_long_wait_threshold_minor: 100000 });
    expect((await want(h, { price_minor: 35000 })).wait_days).toBe(7);
    expect((await api(h, "PUT", "/api/settings", { want_long_wait_threshold_minor: -1 })).status).toBe(400);
  });

  it("decide_after is 00:00 SGT of the added SGT date + wait days", async () => {
    const h = harness({ now: NOON });
    const w = await want(h, { wait_days: 7 }); // added 2026-10-14 12:00 SGT
    expect(w.decide_after).toBe("2026-10-20T16:00:00.000Z"); // 21 Oct 00:00 SGT
    expect(w.left).toEqual({ days: 6, hours: 12, due: false });
    // wait 0: stays 'waiting' with decide_after = today 00:00 SGT; the hourly step makes it ready
    const z = await want(h, { name: "Now", wait_days: 0 });
    expect(z).toMatchObject({ status: "waiting", decide_after: "2026-10-13T16:00:00.000Z" });
    expect(z.left.due).toBe(true);
    await runWantsReady(h.e, h.deps);
    expect((await ok(h, "GET", "/api/wants")).ready.map((x: Obj) => x.id)).toEqual([z.id]);
  });

  it("foreign currency converts at the (mocked) Frankfurter rate; an explicit SGD value is kept; no rate -> 422", async () => {
    const h = harness({ now: NOON, rates: { JPY: 0.0089 } });
    const j = await want(h, { name: "Camera", price_minor: 10000, currency: "jpy" }); // JPY has 0 decimals: 10,000 yen
    expect(j).toMatchObject({ currency: "JPY", price_minor: 10000, price_sgd_minor: 8900, wait_days: 7 });
    expect(h.fxCalls).toHaveLength(1);
    const e = await want(h, { currency: "JPY", price_minor: 10000, price_sgd_minor: 9100 });
    expect(e.price_sgd_minor).toBe(9100);
    const bad = await api(h, "POST", "/api/wants", { name: "Pen", price_minor: 1000, currency: "ZZZ" });
    expect(bad.status).toBe(422);
    expect(await count("SELECT COUNT(*) AS n FROM wants")).toBe(2);
    expect((await api(h, "POST", "/api/wants", { name: "", price_minor: 100 })).status).toBe(400);
    expect((await api(h, "POST", "/api/wants", { name: "x", price_minor: 0 })).status).toBe(400);
    expect((await api(h, "POST", "/api/wants", { name: "x", price_minor: 100, wait_days: 400 })).status).toBe(400);
  });

  it("edits a waiting want (wait recomputed from added_at), blocks edits once decided, deletes", async () => {
    const h = harness({ now: NOON });
    const w = await want(h);
    const e = await ok(h, "PATCH", `/api/wants/${w.id}`, { name: "AirPods Pro case", wait_days: 3, note: "black", url: "https://example.com/x" });
    expect(e).toMatchObject({ name: "AirPods Pro case", wait_days: 3, note: "black", url: "https://example.com/x", decide_after: "2026-10-16T16:00:00.000Z" });
    const p = await ok(h, "PATCH", `/api/wants/${w.id}`, { price_minor: 7000 });
    expect(p.price_sgd_minor).toBe(7000);
    await ok(h, "POST", `/api/wants/${w.id}/skip`);
    expect((await api(h, "PATCH", `/api/wants/${w.id}`, { name: "x" })).status).toBe(409);
    expect((await api(h, "DELETE", `/api/wants/${w.id}`)).status).toBe(200);
    expect((await api(h, "DELETE", `/api/wants/${w.id}`)).status).toBe(404);
    expect((await api(h, "PATCH", "/api/wants/nope", { name: "x" })).status).toBe(404);
  });
});

describe("hourly ready step", () => {
  it("is not ready before decide_after, ready after; nothing sent before", async () => {
    const h = harness({ now: NOON });
    const w = await want(h, { wait_days: 3 }); // decide_after 2026-10-16T16:00Z
    h.setNow(new Date("2026-10-16T15:00:00Z"));
    expect((await runWantsReady(h.e, h.deps)).ready).toEqual([]);
    expect(await outbox("want_ready")).toHaveLength(0);
    h.setNow(new Date("2026-10-16T16:00:00Z"));
    expect((await runWantsReady(h.e, h.deps)).ready).toEqual([w.id]);
    const list = await ok(h, "GET", "/api/wants");
    expect(list.waiting).toEqual([]);
    expect(list.ready).toHaveLength(1);
    expect(list.ready[0].left).toEqual({ days: 0, hours: 0, due: true });
    const sent = await outbox("want_ready");
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!.payload_json)).toMatchObject({ body: "Still want AirPods case (S$59)? Buy / Skip", url: "/wants?tab=ready", tag: "want-ready" });
  });

  it("two items becoming ready give ONE push that batches both; a second run finds nothing", async () => {
    const h = harness({ now: NOON });
    await want(h, { wait_days: 3 });
    h.setNow(new Date("2026-10-14T04:05:00Z"));
    await want(h, { name: "Mug", price_minor: 1800, wait_days: 3 });
    h.setNow(new Date("2026-10-17T02:00:00Z"));
    await runScheduled(h.e, h.deps, CRON_HOURLY); // through the real cron entry
    const sent = await outbox("want_ready");
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!.payload_json).body).toBe("Still want these? AirPods case (S$59), Mug (S$18). Buy / Skip");
    expect(await count("SELECT COUNT(*) AS n FROM wants WHERE status = 'ready'")).toBe(2);
    expect((await runWantsReady(h.e, h.deps)).ready).toEqual([]);
    await runScheduled(h.e, h.deps, CRON_HOURLY);
    expect(await outbox("want_ready")).toHaveLength(1);
  });

  it("goes through the nudge gate: held in quiet hours", async () => {
    const h = harness({ now: NOON });
    await want(h, { wait_days: 0 });
    h.setNow(new Date("2026-10-14T16:30:00Z")); // 00:30 SGT, quiet hours
    await runWantsReady(h.e, h.deps);
    const rows = (await env.DB.prepare("SELECT sent_at, send_after FROM push_outbox WHERE kind = 'want_ready'").all<Obj>()).results;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sent_at).toBeNull();
  });
});

describe("buy and skip", () => {
  it("buying before the wait ended asks once (409), then confirm records bought_early", async () => {
    const h = harness({ now: NOON });
    const w = await want(h);
    const first = await api(h, "POST", `/api/wants/${w.id}/buy`, {});
    expect(first.status).toBe(409);
    expect(first.body).toEqual({ error: "confirm_early", message: "Bought before the wait ended?" });
    expect((await ok(h, "GET", "/api/wants")).waiting).toHaveLength(1); // unchanged
    const r = await ok(h, "POST", `/api/wants/${w.id}/buy`, { confirm_early: true });
    expect(r.want).toMatchObject({ status: "bought", bought_early: 1, decided_at: NOON.toISOString() });
    expect(r.matches).toEqual([]);
  });

  it("buying a ready want needs no confirmation (not early)", async () => {
    const h = harness({ now: NOON });
    const w = await want(h, { wait_days: 3 });
    h.setNow(new Date("2026-10-17T02:00:00Z"));
    await runWantsReady(h.e, h.deps);
    const r = await ok(h, "POST", `/api/wants/${w.id}/buy`);
    expect(r.want).toMatchObject({ status: "bought", bought_early: 0 });
  });

  it("a due want the hourly step hasn't flipped yet is not 'early' either", async () => {
    const h = harness({ now: NOON });
    const w = await want(h, { wait_days: 3 });
    h.setNow(new Date("2026-10-17T02:00:00Z"));
    expect((await ok(h, "POST", `/api/wants/${w.id}/buy`)).want.bought_early).toBe(0);
  });

  it("bought and skipped wants can't change status again", async () => {
    const h = harness({ now: NOON });
    const a = await want(h);
    const b = await want(h, { name: "Mug" });
    await ok(h, "POST", `/api/wants/${a.id}/buy`, { confirm_early: true });
    await ok(h, "POST", `/api/wants/${b.id}/skip`);
    for (const id of [a.id, b.id]) {
      for (const act of ["buy", "skip"]) expect((await api(h, "POST", `/api/wants/${id}/${act}`, { confirm_early: true })).status, `${id} ${act}`).toBe(409);
    }
    expect((await api(h, "POST", "/api/wants/nope/skip")).status).toBe(404);
  });

  it("skip returns the receiving goal as the offer (null with no goal)", async () => {
    const h = harness({ now: NOON });
    const w1 = await want(h);
    const none = await ok(h, "POST", `/api/wants/${w1.id}/skip`);
    expect(none.want).toMatchObject({ status: "skipped", decided_at: NOON.toISOString() });
    expect(none.offer).toBeNull();
    const g = await goal(h);
    await ok(h, "POST", `/api/goals/${g.id}/underspend`, { on: true });
    const w2 = await want(h, { name: "Mug", price_minor: 1800 });
    const r = await ok(h, "POST", `/api/wants/${w2.id}/skip`);
    expect(r.offer).toEqual({ goal_id: g.id, name: "Japan trip", emoji: "🇯🇵", amount: 1800 });
    expect((await ok(h, "GET", "/api/wants")).receiving_goal).toEqual({ id: g.id, name: "Japan trip", emoji: "🇯🇵" });
  });
});

describe("pledging a skipped want", () => {
  it("creates one pledged want_skipped contribution (period = SGT month of the decision); a second pledge is rejected", async () => {
    const h = harness({ now: NOON });
    const g = await goal(h);
    const w = await want(h);
    expect((await api(h, "POST", `/api/wants/${w.id}/pledge`, { goal_id: g.id })).status).toBe(409); // not skipped yet
    await ok(h, "POST", `/api/wants/${w.id}/skip`);
    expect((await api(h, "POST", `/api/wants/${w.id}/pledge`, { goal_id: "nope" })).status).toBe(400);
    const r = await api(h, "POST", `/api/wants/${w.id}/pledge`, { goal_id: g.id });
    expect(r.status).toBe(201);
    const rows = (await env.DB.prepare("SELECT * FROM goal_contributions").all<Obj>()).results;
    expect(rows).toEqual([{ id: `want:${w.id}`, goal_id: g.id, period: "2026-10", amount_sgd_minor: 5900, source: "want_skipped", status: "pledged", created_at: NOON.toISOString(), resolved_at: null }]);
    const again = await api(h, "POST", `/api/wants/${w.id}/pledge`, { goal_id: g.id });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("already_pledged");
    expect(await count("SELECT COUNT(*) AS n FROM goal_contributions")).toBe(1);
    // shown on the goal as pledged, not progress
    const v = ((await ok(h, "GET", "/api/goals")).goals as Obj[])[0]!;
    expect(v.totals).toMatchObject({ pledged: 5900, transferred: 0 });
  });

  it("a bought want can't be pledged", async () => {
    const h = harness({ now: NOON });
    const g = await goal(h);
    const w = await want(h);
    await ok(h, "POST", `/api/wants/${w.id}/buy`, { confirm_early: true });
    expect((await api(h, "POST", `/api/wants/${w.id}/pledge`, { goal_id: g.id })).status).toBe(409);
  });
});

describe("matching a bought want to a transaction", () => {
  it("suggests spend transactions within ±10% and ±14 days, best first; link sets transaction_id", async () => {
    const h = harness({ now: NOON });
    const exact = await insertTxn(5900, "2026-10-12T04:00:00Z");
    const near = await insertTxn(6300, "2026-10-15T04:00:00Z"); // +6.8%, 1 day after
    await insertTxn(6500, "2026-10-13T04:00:00Z"); // +10.2%: out
    await insertTxn(5900, "2026-09-20T04:00:00Z"); // 24 days before: out
    await insertTxn(5900, "2026-10-13T04:00:00Z", { status: "void" }); // void: out
    await insertTxn(5900, "2026-10-13T05:00:00Z", { refund: 1 }); // refund: out
    const w = await want(h);
    const r = await ok(h, "POST", `/api/wants/${w.id}/buy`, { confirm_early: true });
    expect(r.matches.map((t: Obj) => t.id)).toEqual([exact, near]);
    expect((await ok(h, "GET", `/api/wants/${w.id}/matches`)).matches.map((t: Obj) => t.id)).toEqual([exact, near]);

    const linked = await ok(h, "POST", `/api/wants/${w.id}/link`, { transaction_id: near });
    expect(linked.transaction_id).toBe(near);
    expect((await ok(h, "GET", `/api/wants/${w.id}/matches`)).matches).toEqual([]); // already linked
    expect((await api(h, "POST", `/api/wants/${w.id}/link`, { transaction_id: "nope" })).status).toBe(400);
    // a transaction linked to one want is not offered to the next
    const w2 = await want(h, { name: "Case 2" });
    const r2 = await ok(h, "POST", `/api/wants/${w2.id}/buy`, { confirm_early: true });
    expect(r2.matches.map((t: Obj) => t.id)).toEqual([exact]);
    // only bought wants can be linked
    const w3 = await want(h, { name: "Case 3" });
    expect((await api(h, "POST", `/api/wants/${w3.id}/link`, { transaction_id: exact })).status).toBe(409);
  });
});

describe("list and stats", () => {
  it("skipped this year counts total and items; a skip last year is not counted; decided is newest first", async () => {
    const h = harness({ now: new Date("2025-12-30T04:00:00Z") });
    const old = await want(h, { name: "Old", price_minor: 9900 });
    await ok(h, "POST", `/api/wants/${old.id}/skip`); // 30 Dec 2025
    h.setNow(new Date("2026-01-02T04:00:00Z"));
    const a = await want(h, { name: "A", price_minor: 5900 });
    h.setNow(new Date("2026-03-02T04:00:00Z"));
    await ok(h, "POST", `/api/wants/${a.id}/skip`);
    h.setNow(new Date("2026-10-14T04:00:00Z"));
    const b = await want(h, { name: "B", price_minor: 35000 });
    await ok(h, "POST", `/api/wants/${b.id}/skip`);
    h.setNow(new Date("2026-10-14T05:00:00Z"));
    const c = await want(h, { name: "C", price_minor: 1200 });
    await ok(h, "POST", `/api/wants/${c.id}/buy`, { confirm_early: true }); // bought: not a skip
    await want(h, { name: "D", price_minor: 800 }); // waiting: not a skip

    const list = await ok(h, "GET", "/api/wants");
    expect(list.stats).toEqual({ year: 2026, skipped_total_minor: 5900 + 35000, skipped_count: 2 });
    expect(list.waiting.map((w: Obj) => w.name)).toEqual(["D"]);
    expect(list.decided.map((w: Obj) => w.name)).toEqual(["C", "B", "A", "Old"]);
    expect((await ok(h, "GET", "/api/wants/stats"))).toEqual(list.stats);
    // SGT year boundary: 31 Dec 2026 17:00 UTC is already 2027 in SGT
    h.setNow(new Date("2026-12-31T17:00:00Z"));
    expect((await ok(h, "GET", "/api/wants/stats")).skipped_count).toBe(0);
  });
});
