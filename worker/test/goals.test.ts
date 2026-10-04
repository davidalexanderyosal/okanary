import { env } from "cloudflare:test";
import { applyBp, goalsSummaryLine } from "@okanary/core";
import { beforeEach, describe, expect, it } from "vitest";
import { CRON_HOURLY, runScheduled } from "../src/cron";
import { runUnderspendPledges } from "../src/goals";
import { runNetworthJob } from "../src/networth-job";
import { sendMonthlySummary } from "../src/networth-summary";
import { _resetRateLimit } from "../src/routes/ingest";
import { count, harness, json, resetDb } from "./helpers";

beforeEach(async () => { _resetRateLimit(); await resetDb(); });

const D1 = new Date("2026-10-13T22:30:00Z"); // 14 Oct 2026 06:30 SGT (the net worth cron time)
const D2 = new Date("2026-10-14T22:30:00Z"); // 15 Oct 06:30 SGT
const NOON = new Date("2026-10-14T04:00:00Z"); // 14 Oct 12:00 SGT
const MON_MIDNIGHT = new Date("2026-10-11T16:00:00Z"); // Mon 12 Oct 2026 00:00 SGT

type H = ReturnType<typeof harness>;
type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function setup(now: Date = NOON, rates: Record<string, number> = { USD: 1.3 }) {
  const finnhub: Record<string, number> = {};
  const h = harness({
    now, rates,
    onFetch: (u) => {
      const url = new URL(u);
      if (url.hostname !== "finnhub.io") return undefined;
      const c = finnhub[url.searchParams.get("symbol")!];
      return c === undefined ? new Response("err", { status: 500 }) : Response.json({ c, pc: c });
    },
  });
  h.e.FINNHUB_API_KEY = "fk";
  return { h, finnhub };
}

const api = async (h: H, method: string, path: string, body?: unknown) => {
  const r = await h.call(path, body === undefined ? { method } : json(method, body));
  return { status: r.status, body: (await r.json()) as Obj };
};
const ok = async (h: H, method: string, path: string, body?: unknown): Promise<Obj> => {
  const r = await api(h, method, path, body);
  expect(r.status, `${method} ${path} ${JSON.stringify(r.body)}`).toBeLessThan(300);
  return r.body;
};
const goal = (h: H, o: Obj) => ok(h, "POST", "/api/goals", { name: "Goal", kind: "short", target_today_minor: 100000, ...o });
const list = async (h: H) => (await ok(h, "GET", "/api/goals")) as { today: string; goals: Obj[]; summary: string | null; receiving_goal_id: string | null; warnings: Obj[] };
const account = (h: H, o: Obj) => ok(h, "POST", "/api/nw/accounts", o);
const balance = (h: H, id: string, amount_minor: number) => ok(h, "POST", `/api/nw/accounts/${id}/balances`, { amount_minor });
const holding = (h: H, o: Obj) => ok(h, "POST", "/api/nw/holdings", o);
const link = (h: H, goalId: string, o: Obj) => ok(h, "POST", `/api/goals/${goalId}/funding`, o);
const outbox = async (kind: string) => (await env.DB.prepare("SELECT * FROM push_outbox WHERE kind = ? ORDER BY created_at").bind(kind).all<{ payload_json: string; tag: string | null }>()).results;

let seq = 0;
async function insertTxn(minor: number, category: string, occurred_at: string) {
  await env.DB.prepare("INSERT INTO transactions (id, occurred_at, amount_minor, currency, amount_sgd_minor, status, source, category_id, created_at, updated_at) VALUES (?,?,?,?,?,'confirmed','manual',?,'x','x')")
    .bind(`g${++seq}`, occurred_at, minor, "SGD", minor, category).run();
}

describe("goals CRUD", () => {
  it("creates, reads, edits and archives a goal; validates input", async () => {
    const { h } = setup();
    const g = await goal(h, { name: "  Japan trip ", emoji: "🇯🇵", target_today_minor: 300000 });
    expect(g).toMatchObject({ name: "Japan trip", emoji: "🇯🇵", kind: "short", priority: 1, horizon: "short", target: 300000, target_today_minor: 300000, value: 0, receives_underspend: false });
    expect(g.start_date).toBe("2026-10-14");
    expect(g.created_at).toBe(NOON.toISOString());
    expect(await env.DB.prepare("SELECT horizon, target_sgd_minor, start_date FROM goals WHERE id = ?").bind(g.id).first()).toEqual({ horizon: "short", target_sgd_minor: 300000, start_date: "2026-10-14" });

    const second = await goal(h, { name: "Laptop" });
    expect(second.priority).toBe(2);

    const detail = await ok(h, "GET", `/api/goals/${g.id}`);
    expect(detail).toMatchObject({ id: g.id, history: [], contributions: [], cone: null });
    expect(detail.path).toHaveLength(13); // 12 months (no target date) + now

    const patched = await ok(h, "PATCH", `/api/goals/${g.id}`, { name: "Japan 2027", target_today_minor: 450000, target_date: "2027-03-01" });
    expect(patched).toMatchObject({ name: "Japan 2027", target: 450000, target_date: "2027-03-01", horizon: "short" });

    expect((await api(h, "POST", "/api/goals", { kind: "short", target_today_minor: 1000 })).status).toBe(400); // no name
    expect((await api(h, "POST", "/api/goals", { name: "x", kind: "short" })).status).toBe(400); // no target
    expect((await api(h, "POST", "/api/goals", { name: "x", kind: "nope", target_today_minor: 5 })).status).toBe(400);
    expect((await api(h, "POST", "/api/goals", { name: "x", kind: "short", target_today_minor: 12.5 })).status).toBe(400);
    expect((await api(h, "POST", "/api/goals", { name: "x", kind: "short", target_today_minor: 5, target_date: "2027-02-30" })).status).toBe(400);
    expect((await api(h, "POST", "/api/goals", { name: "x", kind: "short", target_today_minor: 5, return_bp: -1 })).status).toBe(400);
    expect((await api(h, "PATCH", `/api/goals/${g.id}`, { target_today_minor: 0 })).status).toBe(400);
    expect((await api(h, "PATCH", "/api/goals/nope", { name: "x" })).status).toBe(404);
    expect((await api(h, "GET", "/api/goals/nope")).status).toBe(404);

    expect(await ok(h, "DELETE", `/api/goals/${g.id}`)).toEqual({ id: g.id, archived: true });
    expect((await list(h)).goals.map((x) => x.id)).toEqual([second.id]);
    expect((await api(h, "GET", `/api/goals/${g.id}`)).status).toBe(404);
    expect(await count("SELECT COUNT(*) AS n FROM goals")).toBe(2); // archived, not deleted
    expect((await api(h, "DELETE", "/api/goals/nope")).status).toBe(404);
  });

  it("an emergency goal goes first and shifts the others down", async () => {
    const { h } = setup();
    const a = await goal(h, { name: "Holiday" });
    const b = await goal(h, { name: "Wedding", kind: "mid", target_date: "2031-10-14" });
    const e = await goal(h, { name: "Emergency fund", kind: "emergency", target_today_minor: 1200000 });
    expect(e.priority).toBe(1);
    const prio = async () => Object.fromEntries((await list(h)).goals.map((g) => [g.name, g.priority]));
    expect(await prio()).toEqual({ "Emergency fund": 1, Holiday: 2, Wedding: 3 });
    expect((await list(h)).goals.map((g) => g.id)).toEqual([e.id, a.id, b.id]);
    expect(e).toMatchObject({ horizon: "short", target: 1200000 }); // fixed amount, no date
  });

  it("reorders goals to priorities 1..n", async () => {
    const { h } = setup();
    const a = await goal(h, { name: "A" });
    const b = await goal(h, { name: "B" });
    const c = await goal(h, { name: "C" });
    await ok(h, "POST", "/api/goals/reorder", { ids: [c.id, a.id, b.id] });
    const l = (await list(h)).goals;
    expect(l.map((g) => [g.name, g.priority])).toEqual([["C", 1], ["A", 2], ["B", 3]]);
    expect((await api(h, "POST", "/api/goals/reorder", { ids: [c.id, "nope"] })).status).toBe(400);
    expect((await api(h, "POST", "/api/goals/reorder", { ids: [c.id, c.id] })).status).toBe(400);
    await ok(h, "POST", "/api/goals/reorder", { ids: [b.id] }); // unlisted goals follow in their current order
    expect((await list(h)).goals.map((g) => g.name)).toEqual(["B", "C", "A"]);
  });

  it("only one goal receives underspend", async () => {
    const { h } = setup();
    const a = await goal(h, { name: "A" });
    const b = await goal(h, { name: "B" });
    const flags = async () => (await env.DB.prepare("SELECT name, receives_underspend AS f FROM goals ORDER BY name").all<{ name: string; f: number }>()).results.map((r) => r.f);
    await ok(h, "POST", `/api/goals/${a.id}/underspend`, { on: true });
    expect(await flags()).toEqual([1, 0]);
    expect((await list(h)).receiving_goal_id).toBe(a.id);
    await ok(h, "POST", `/api/goals/${b.id}/underspend`, { on: true });
    expect(await flags()).toEqual([0, 1]);
    expect((await list(h)).receiving_goal_id).toBe(b.id);
    const c = await goal(h, { name: "C", receives_underspend: true }); // create with the flag moves it too
    expect(await flags()).toEqual([0, 0, 1]);
    await ok(h, "PATCH", `/api/goals/${a.id}`, { receives_underspend: true });
    expect(await flags()).toEqual([1, 0, 0]);
    await ok(h, "POST", `/api/goals/${a.id}/underspend`, { on: false });
    expect(await flags()).toEqual([0, 0, 0]);
    expect(c.receives_underspend).toBe(true);
    expect((await api(h, "POST", "/api/goals/nope/underspend", { on: true })).status).toBe(404);
    expect((await api(h, "POST", `/api/goals/${a.id}/underspend`, { on: "yes" })).status).toBe(400);
  });
});

describe("targets and horizons", () => {
  it("inflates a mid goal's target: S$60,000 today, 5 years, 3% -> S$69,556.44", async () => {
    const { h } = setup();
    const g = await goal(h, { name: "MBA tuition", kind: "mid", target_today_minor: 6000000, target_date: "2031-10-14", inflation_bp: 300 });
    expect(g).toMatchObject({ horizon: "mid", target: 6955644, target_today_minor: 6000000, return_bp: 400, return_bp_is_default: true });
    expect((await env.DB.prepare("SELECT target_sgd_minor AS t, horizon FROM goals WHERE id = ?").bind(g.id).first())).toEqual({ t: 6955644, horizon: "mid" });
    expect((await list(h)).goals[0]!.target).toBe(6955644);
    // default inflation 3% when omitted; editing the date recomputes both
    const p = await ok(h, "PATCH", `/api/goals/${g.id}`, { target_date: "2036-10-14", inflation_bp: 400 });
    expect(p.target).toBe(Math.round(6000000 * Math.pow(1.04, 10)));
    expect(p.horizon).toBe("long");
  });

  it("the retirement helper is monthly spending × 12 × 25, in today's dollars, inflated to the date", async () => {
    const { h } = setup();
    const g = await goal(h, { name: "Retirement", kind: "retirement", retirement_monthly_minor: 400000, target_date: "2056-10-14", target_today_minor: undefined });
    expect(g).toMatchObject({ target_today_minor: 120000000, horizon: "long", return_bp: 600 });
    expect(g.target).toBe(Math.round(120000000 * Math.pow(1.03, 30)));
    expect(g.range).toMatchObject({ conservative: expect.any(Number), base: expect.any(Number), optimistic: expect.any(Number) });
    expect(g.range.conservative).toBeLessThanOrEqual(g.range.base);
    expect(g.range.base).toBeLessThanOrEqual(g.range.optimistic);
    // an editable estimate: a plain target works too; neither is an error
    expect((await goal(h, { name: "R2", kind: "retirement", target_today_minor: 5000000 })).target_today_minor).toBe(5000000);
    expect((await api(h, "POST", "/api/goals", { name: "R3", kind: "retirement" })).status).toBe(400);
  });

  it("goal detail has history, contributions, a projection path and a cone for long goals", async () => {
    const { h } = setup();
    const g = await goal(h, { name: "Retirement", kind: "retirement", target_today_minor: 10000000, target_date: "2046-10-14", return_bp: 100 });
    await ok(h, "POST", `/api/goals/${g.id}/contributions`, { amount_sgd_minor: 500000 });
    const d = await ok(h, "GET", `/api/goals/${g.id}`);
    expect(d.status.monthsLeft).toBe(240);
    expect(d.path).toHaveLength(241);
    expect(d.path[0]).toBe(500000);
    expect(d.cone.conservative).toHaveLength(241);
    expect(d.cone.optimistic).toHaveLength(241);
    expect(d.cone.conservative[240]).toBeLessThanOrEqual(d.path[240]);
    expect(d.path[240]).toBeLessThanOrEqual(d.cone.optimistic[240]);
    expect(Math.min(...d.cone.conservative)).toBeGreaterThanOrEqual(0); // return 1% - 2 pp is floored at 0%
    expect(d.contributions).toHaveLength(1);
  });
});

describe("funding", () => {
  it("values a goal from a linked holding at a share (net worth job, mocked fetch)", async () => {
    const { h, finnhub } = setup(D1);
    finnhub.VOO = 450.25;
    const cash = await account(h, { name: "DBS Savings", kind: "cash" });
    await balance(h, cash.id, 100000);
    const broker = await account(h, { name: "Moomoo", kind: "brokerage", currency: "USD" });
    const voo = await holding(h, { account_id: broker.id, asset_type: "us_equity", symbol: "VOO", quantity: "10" });
    const retire = await goal(h, { name: "Retirement", kind: "long", target_today_minor: 5000000, target_date: "2046-10-14" });
    const share = await goal(h, { name: "House", kind: "mid", target_today_minor: 3000000, target_date: "2032-10-14" });
    const whole = await goal(h, { name: "Broker", kind: "mid", target_today_minor: 3000000, target_date: "2032-10-14" });
    const sav = await goal(h, { name: "Cash goal" });
    await link(h, share.id, { source_type: "holding", source_id: voo.id, share_bp: 4000 });
    await link(h, whole.id, { source_type: "nw_account", source_id: broker.id });
    await link(h, sav.id, { source_type: "nw_account", source_id: cash.id });
    await link(h, retire.id, { source_type: "holding", source_id: voo.id, share_bp: 6000 }); // 40% + 60% = exactly 100%: no warning
    await runNetworthJob(h.e, h.deps); // 10 x US$450.25 x 1.30 = S$5,853.25

    const l = await list(h);
    const byName = Object.fromEntries(l.goals.map((g) => [g.name, g]));
    expect(byName.House.value).toBe(applyBp(585325, 4000)); // 234,130
    expect(byName.House.funding).toHaveLength(1);
    expect(byName.Broker.value).toBe(585325); // the account value includes its holdings
    expect(byName["Cash goal"].value).toBe(100000);
    expect(byName.House.status).toMatchObject({ target: byName.House.target, value: 234130 });
    expect(byName.Retirement.value).toBe(applyBp(585325, 6000));
    expect(l.warnings).toEqual([]);
    expect(l.summary).toMatch(/^Goals: /);
  });

  it("without a stored snapshot the current values come live from cached inputs", async () => {
    const { h } = setup();
    const cash = await account(h, { name: "Savings", kind: "cash" });
    await balance(h, cash.id, 123456);
    const g = await goal(h, { name: "Holiday" });
    await link(h, g.id, { source_type: "nw_account", source_id: cash.id });
    expect(await count("SELECT COUNT(*) AS n FROM networth_snapshots")).toBe(0);
    expect((await list(h)).goals[0]!.value).toBe(123456);
  });

  it("an earmark: set aside inside an account; over-allocating across two goals is a warning, not an error", async () => {
    const { h } = setup();
    const cash = await account(h, { name: "DBS Savings", kind: "cash" });
    await balance(h, cash.id, 100000);
    const a = await goal(h, { name: "Holiday" });
    const b = await goal(h, { name: "Laptop" });
    const first = await ok(h, "POST", `/api/goals/${a.id}/funding`, { source_type: "earmark", source_id: cash.id, earmark_minor: 60000 });
    expect(first.warnings).toEqual([]);
    expect(first.link).toMatchObject({ source_type: "earmark", share_bp: null, earmark_minor: 60000 });
    const second = await api(h, "POST", `/api/goals/${b.id}/funding`, { source_type: "earmark", source_id: cash.id, earmark_minor: 60000 });
    expect(second.status).toBe(201);
    expect(second.body.warnings).toEqual([{ type: "earmark_over", account_id: cash.id, claimed: 120000, balance: 100000, goal_ids: [a.id, b.id] }]);
    const l = await list(h);
    expect(l.warnings).toHaveLength(1);
    expect(l.goals.every((g) => g.warnings.length === 1)).toBe(true);
    expect(l.goals.map((g) => g.value)).toEqual([60000, 60000]); // earmarks are the value

    // removing one clears the warning
    const del = await ok(h, "DELETE", `/api/goal-funding/${second.body.link.id}`);
    expect(del).toEqual({ ok: true, warnings: [] });
    expect((await api(h, "DELETE", "/api/goal-funding/nope")).status).toBe(404);
  });

  it("shares of one holding above 100% across goals warn", async () => {
    const { h, finnhub } = setup(D1);
    finnhub.VOO = 450.25;
    const broker = await account(h, { name: "Moomoo", kind: "brokerage", currency: "USD" });
    const voo = await holding(h, { account_id: broker.id, asset_type: "us_equity", symbol: "VOO", quantity: "10" });
    const a = await goal(h, { name: "A" });
    const b = await goal(h, { name: "B" });
    expect((await link(h, a.id, { source_type: "holding", source_id: voo.id, share_bp: 6000 })).warnings).toEqual([]);
    const r = await link(h, b.id, { source_type: "holding", source_id: voo.id, share_bp: 6000 });
    expect(r.warnings).toEqual([{ type: "share_over", source_type: "holding", source_id: voo.id, total_bp: 12000, goal_ids: [a.id, b.id] }]);
  });

  it("validates funding links", async () => {
    const { h } = setup();
    const cash = await account(h, { name: "Savings", kind: "cash" });
    const g = await goal(h, { name: "A" });
    const post = (b: Obj) => api(h, "POST", `/api/goals/${g.id}/funding`, b);
    expect((await post({ source_type: "earmark", source_id: cash.id })).status).toBe(400); // earmark needs an amount
    expect((await post({ source_type: "nw_account", source_id: "nope" })).status).toBe(400);
    expect((await post({ source_type: "holding", source_id: cash.id })).status).toBe(400); // an account id is not a holding
    expect((await post({ source_type: "nw_account", source_id: cash.id, share_bp: 10001 })).status).toBe(400);
    expect((await post({ source_type: "nw_account", source_id: cash.id, share_bp: 0 })).status).toBe(400);
    expect((await api(h, "POST", "/api/goals/nope/funding", { source_type: "nw_account", source_id: cash.id })).status).toBe(404);
    const okRes = await post({ source_type: "nw_account", source_id: cash.id });
    expect(okRes.status).toBe(201);
    expect(okRes.body.link.share_bp).toBe(10000); // default 100%
    expect((await post({ source_type: "nw_account", source_id: cash.id })).status).toBe(409); // already linked
  });
});

describe("emergency suggestion", () => {
  it("is 6 x the average monthly Essentials spend", async () => {
    const { h } = setup(); // 14 Oct 2026
    await insertTxn(100000, "groceries", "2026-07-10T03:00:00Z");
    await insertTxn(200000, "groceries", "2026-08-10T03:00:00Z");
    await insertTxn(300000, "groceries", "2026-09-10T03:00:00Z");
    await insertTxn(999999, "food", "2026-09-11T03:00:00Z"); // Lifestyle: ignored
    await insertTxn(50000, "groceries", "2026-10-02T03:00:00Z"); // current month: not complete
    const s = await ok(h, "GET", "/api/goals/emergency-suggestion");
    expect(s).toEqual({ average: 200000, months: ["2026-09", "2026-08", "2026-07"], target: 1200000 });
  });

  it("has no suggestion without data", async () => {
    const { h } = setup();
    expect(await ok(h, "GET", "/api/goals/emergency-suggestion")).toEqual({ average: null, months: [], target: null });
  });
});

describe("contributions and pledges", () => {
  it("progress counts transferred money only; pledged shows apart; transfer and skip only from pledged", async () => {
    const { h } = setup();
    const g = await goal(h, { name: "Holiday", target_today_minor: 100000 });
    const t = await ok(h, "POST", `/api/goals/${g.id}/contributions`, { amount_sgd_minor: 20000 });
    expect(t).toMatchObject({ status: "transferred", source: "manual", period: "manual", resolved_at: NOON.toISOString() });
    const p1 = await ok(h, "POST", `/api/goals/${g.id}/contributions`, { amount_sgd_minor: 30000, status: "pledged" });
    const p2 = await ok(h, "POST", `/api/goals/${g.id}/contributions`, { amount_sgd_minor: 7000, status: "pledged" });
    expect(p1.resolved_at).toBeNull();

    let v = (await list(h)).goals[0]!;
    expect(v.value).toBe(20000);
    expect(v.totals).toEqual({ transferred: 20000, pledged: 37000, skipped: 0 });
    expect(v.pledges.map((c: Obj) => c.id).sort()).toEqual([p1.id, p2.id].sort());

    const tr = await ok(h, "POST", `/api/goal-contributions/${p1.id}/transfer`);
    expect(tr).toMatchObject({ status: "transferred", resolved_at: NOON.toISOString() });
    await ok(h, "POST", `/api/goal-contributions/${p2.id}/skip`);
    v = (await list(h)).goals[0]!;
    expect(v.value).toBe(50000);
    expect(v.totals).toEqual({ transferred: 50000, pledged: 0, skipped: 7000 });
    expect(v.pledges).toEqual([]);

    expect((await api(h, "POST", `/api/goal-contributions/${p1.id}/skip`)).status).toBe(409); // not pledged any more
    expect((await api(h, "POST", `/api/goal-contributions/${p2.id}/transfer`)).status).toBe(409);
    expect((await api(h, "POST", "/api/goal-contributions/nope/transfer")).status).toBe(404);
    expect((await api(h, "POST", `/api/goals/${g.id}/contributions`, { amount_sgd_minor: 0 })).status).toBe(400);
    expect((await api(h, "POST", `/api/goals/${g.id}/contributions`, { amount_sgd_minor: 5, status: "skipped" })).status).toBe(400);
    expect((await api(h, "POST", "/api/goals/nope/contributions", { amount_sgd_minor: 5 })).status).toBe(404);

    const d = await ok(h, "GET", `/api/goals/${g.id}`);
    expect(d.contributions).toHaveLength(3);
  });

  it("a goal with share links does not double count transfers (they land in the linked account)", async () => {
    const { h } = setup();
    const cash = await account(h, { name: "Savings", kind: "cash" });
    await balance(h, cash.id, 100000);
    const g = await goal(h, { name: "Holiday" });
    await link(h, g.id, { source_type: "nw_account", source_id: cash.id });
    await ok(h, "POST", `/api/goals/${g.id}/contributions`, { amount_sgd_minor: 20000 });
    const v = (await list(h)).goals[0]!;
    expect(v.value).toBe(100000);
    expect(v.totals.transferred).toBe(20000);
  });
});

describe("daily goal snapshots and pace", () => {
  it("pace excludes market moves: a price-only change gives pace 0", async () => {
    const { h, finnhub } = setup(D1);
    finnhub.VOO = 450.25;
    const broker = await account(h, { name: "Moomoo", kind: "brokerage", currency: "USD" });
    const voo = await holding(h, { account_id: broker.id, asset_type: "us_equity", symbol: "VOO", quantity: "10" });
    const g = await goal(h, { name: "Retirement", kind: "long", target_today_minor: 5000000, target_date: "2046-10-14" });
    await link(h, g.id, { source_type: "holding", source_id: voo.id });
    await runNetworthJob(h.e, h.deps);

    h.setNow(D2);
    finnhub.VOO = 460.25; // +US$100 x 1.3 = +S$130.00 of pure market
    await runNetworthJob(h.e, h.deps);
    const snaps = (await env.DB.prepare("SELECT date, value_sgd_minor AS v FROM goal_snapshots WHERE goal_id = ? ORDER BY date").bind(g.id).all()).results;
    expect(snaps).toEqual([{ date: "2026-10-14", v: 585325 }, { date: "2026-10-15", v: 598325 }]);

    const v = (await list(h)).goals[0]!;
    expect(v.value).toBe(598325);
    expect(v.pace).toBe(0); // 598,325 - 585,325 - 13,000 market
    expect((await ok(h, "GET", `/api/goals/${g.id}`)).history).toEqual([{ date: "2026-10-14", value_sgd_minor: 585325 }, { date: "2026-10-15", value_sgd_minor: 598325 }]);
  });

  it("pace counts what David adds: a balance top-up on a linked cash account", async () => {
    const { h } = setup(D1);
    const cash = await account(h, { name: "Savings", kind: "cash" });
    await balance(h, cash.id, 100000);
    const g = await goal(h, { name: "Holiday", target_today_minor: 1000000, target_date: "2027-10-14" });
    await link(h, g.id, { source_type: "nw_account", source_id: cash.id });
    await runNetworthJob(h.e, h.deps);
    expect((await list(h)).goals[0]!.pace).toBeNull(); // no earlier snapshot yet

    h.setNow(D2);
    await balance(h, cash.id, 150000);
    await runNetworthJob(h.e, h.deps);
    const v = (await list(h)).goals[0]!;
    expect(v.value).toBe(150000);
    expect(v.pace).toBe(50000); // 1 day elapsed counts as at least one month
    expect(v.status.pace).toBe(50000);
    // re-running the job the same day leaves one snapshot per day
    await runNetworthJob(h.e, h.deps);
    expect(await count("SELECT COUNT(*) AS n FROM goal_snapshots")).toBe(2);
  });
});

describe("horizon re-classification and the safer-funding prompt", () => {
  it("fires once when a goal funded by a holding crosses below 2 years", async () => {
    const { h, finnhub } = setup(D1);
    finnhub.VOO = 450.25;
    const cash = await account(h, { name: "Savings", kind: "cash" });
    await balance(h, cash.id, 100000);
    const broker = await account(h, { name: "Moomoo", kind: "brokerage", currency: "USD" });
    const voo = await holding(h, { account_id: broker.id, asset_type: "us_equity", symbol: "VOO", quantity: "10" });
    // 24 whole months from 14 Oct 2026, 23 from 15 Oct
    const mba = await goal(h, { name: "MBA tuition", kind: "mid", target_today_minor: 6000000, target_date: "2028-10-14" });
    const safe = await goal(h, { name: "Cash only", kind: "mid", target_today_minor: 2000000, target_date: "2028-10-14" });
    expect(mba.horizon).toBe("mid");
    await link(h, mba.id, { source_type: "holding", source_id: voo.id });
    await link(h, safe.id, { source_type: "nw_account", source_id: cash.id });

    await runNetworthJob(h.e, h.deps); // 14 Oct: still mid
    const horizon = async () => (await env.DB.prepare("SELECT id, horizon FROM goals").all<{ id: string; horizon: string }>()).results.map((r) => r.horizon);
    expect(await horizon()).toEqual(["mid", "mid"]);
    expect(await count("SELECT COUNT(*) AS n FROM alert_log WHERE kind = 'goal_safer_funding'")).toBe(0);
    expect((await list(h)).goals.every((g) => !g.safer_funding_suggested)).toBe(true);

    h.setNow(D2);
    await runNetworthJob(h.e, h.deps); // 15 Oct: 23 months -> short
    expect(await horizon()).toEqual(["short", "short"]);
    const alerts = (await env.DB.prepare("SELECT kind, ref, period FROM alert_log WHERE kind = 'goal_safer_funding'").all()).results;
    expect(alerts).toEqual([{ kind: "goal_safer_funding", ref: mba.id, period: "once" }]); // not for the cash-only goal
    const sent = await outbox("goal_safer_funding");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.tag).toBe(`safer-${mba.id}`);
    expect(JSON.parse(sent[0]!.payload_json)).toMatchObject({ url: `/money/goals/${mba.id}`, body: expect.stringContaining("‘MBA tuition’ is now under 2 years away. Fund it from cash instead of stocks/crypto?") });

    const l = await list(h);
    expect(Object.fromEntries(l.goals.map((g) => [g.name, [g.horizon, g.safer_funding_suggested]]))).toEqual({ "MBA tuition": ["short", true], "Cash only": ["short", false] });

    // a third run (same day), and the next day, add nothing
    await runNetworthJob(h.e, h.deps);
    h.setNow(new Date("2026-10-15T22:30:00Z"));
    await runNetworthJob(h.e, h.deps);
    expect(await count("SELECT COUNT(*) AS n FROM alert_log WHERE kind = 'goal_safer_funding'")).toBe(1);
    expect((await outbox("goal_safer_funding"))).toHaveLength(1);
    // the stored target follows the date: mid goals are inflated to the date, so it shrinks with time
    expect(await env.DB.prepare("SELECT target_sgd_minor AS t FROM goals WHERE id = ?").bind(mba.id).first<{ t: number }>()).toEqual({ t: expect.any(Number) });
  });
});

describe("weekly underspend pledges", () => {
  // Week Mon 5 - Sun 11 Oct 2026 = '2026-W41'; allowance for a S$900/month Lifestyle budget = 20,322 (D-47).
  const WEEK_ALLOWANCE = 20322;
  const setBudget = (h: H) => ok(h, "PUT", "/api/budgets", { scope: "group", ref_id: "lifestyle", month: "2026-10", amount_sgd_minor: 90000 });

  it("pledges last week's underspend to the receiving goal, once, with one nudge", async () => {
    const { h } = setup(MON_MIDNIGHT);
    await setBudget(h);
    await insertTxn(12000, "food", "2026-10-07T03:00:00Z"); // last week, Lifestyle
    await insertTxn(500000, "groceries", "2026-10-08T03:00:00Z"); // Essentials: not counted
    await insertTxn(99999, "food", "2026-10-12T03:00:00Z"); // this week: not counted
    const g = await goal(h, { name: "Japan trip", emoji: "🇯🇵", target_today_minor: 300000 });
    await ok(h, "POST", `/api/goals/${g.id}/underspend`, { on: true });

    const r = await runUnderspendPledges(h.e, h.deps);
    expect(r).toMatchObject({ amount: WEEK_ALLOWANCE - 12000, period: "2026-W41" });
    const rows = (await env.DB.prepare("SELECT * FROM goal_contributions").all<Obj>()).results;
    expect(rows).toEqual([{ id: r.created, goal_id: g.id, period: "2026-W41", amount_sgd_minor: 8322, source: "underspend", status: "pledged", created_at: MON_MIDNIGHT.toISOString(), resolved_at: null }]);
    const sent = await outbox("underspend_pledge");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.tag).toBe("underspend");
    expect(JSON.parse(sent[0]!.payload_json)).toEqual({
      title: "Okanary: goals", body: "Last week you came in S$83 under. Move S$83 to 🇯🇵 Japan trip?",
      url: `/money/goals?pledge=${r.created}`, tag: "underspend", pledge: r.created, actions: "transfer,skip",
    });

    // second run: nothing new
    const again = await runUnderspendPledges(h.e, h.deps);
    expect(again).toMatchObject({ created: null, reason: "already_pledged" });
    expect(await count("SELECT COUNT(*) AS n FROM goal_contributions")).toBe(1);
    expect(await outbox("underspend_pledge")).toHaveLength(1);

    // it is listed on the goal as pledged, not counted as progress
    const v = (await list(h)).goals[0]!;
    expect(v.totals).toEqual({ transferred: 0, pledged: 8322, skipped: 0 });
    expect(v.value).toBe(0);
  });

  it("without an emoji the push names just the goal", async () => {
    const { h } = setup(MON_MIDNIGHT);
    await setBudget(h);
    const g = await goal(h, { name: "Laptop" });
    await ok(h, "POST", `/api/goals/${g.id}/underspend`, { on: true });
    await runUnderspendPledges(h.e, h.deps);
    expect(JSON.parse((await outbox("underspend_pledge"))[0]!.payload_json).body).toBe("Last week you came in S$203 under. Move S$203 to Laptop?");
  });

  it("with no goal marked, the highest-priority behind goal receives it; with none behind, nothing", async () => {
    const { h } = setup(MON_MIDNIGHT);
    await setBudget(h);
    const done = await goal(h, { name: "Done", target_today_minor: 10000 });
    await ok(h, "POST", `/api/goals/${done.id}/contributions`, { amount_sgd_minor: 10000 }); // reached
    expect((await list(h)).receiving_goal_id).toBeNull();
    expect(await runUnderspendPledges(h.e, h.deps)).toMatchObject({ created: null, reason: "no_goal" });
    expect(await count("SELECT COUNT(*) AS n FROM goal_contributions WHERE source = 'underspend'")).toBe(0);
    expect(await outbox("underspend_pledge")).toHaveLength(0);

    const behind = await goal(h, { name: "Trip", target_today_minor: 5000000, target_date: "2027-01-14" }); // far from target, no pace
    expect((await list(h)).receiving_goal_id).toBe(behind.id);
    const r = await runUnderspendPledges(h.e, h.deps);
    expect(r.created).not.toBeNull();
    expect((await env.DB.prepare("SELECT goal_id FROM goal_contributions WHERE source = 'underspend'").first<{ goal_id: string }>())!.goal_id).toBe(behind.id);
  });

  it("nothing when the week was overspent or there is no allowance", async () => {
    const { h } = setup(MON_MIDNIGHT);
    const g = await goal(h, { name: "Trip" });
    await ok(h, "POST", `/api/goals/${g.id}/underspend`, { on: true });
    expect(await runUnderspendPledges(h.e, h.deps)).toMatchObject({ created: null, reason: "no_allowance" });
    await setBudget(h);
    await insertTxn(WEEK_ALLOWANCE + 1, "food", "2026-10-07T03:00:00Z");
    expect(await runUnderspendPledges(h.e, h.deps)).toMatchObject({ created: null, reason: "no_underspend", amount: 0 });
    expect(await count("SELECT COUNT(*) AS n FROM goal_contributions")).toBe(0);
    expect(await outbox("underspend_pledge")).toHaveLength(0);
  });

  it("the hourly cron triggers it at Monday 00:00 SGT only", async () => {
    const { h } = setup(MON_MIDNIGHT);
    await setBudget(h);
    const g = await goal(h, { name: "Trip" });
    await ok(h, "POST", `/api/goals/${g.id}/underspend`, { on: true });
    const pledges = () => count("SELECT COUNT(*) AS n FROM goal_contributions WHERE source = 'underspend'");

    h.setNow(new Date("2026-10-11T15:00:00Z")); // Sun 23:00 SGT
    await runScheduled(h.e, h.deps, CRON_HOURLY);
    h.setNow(new Date("2026-10-11T17:00:00Z")); // Mon 01:00 SGT
    await runScheduled(h.e, h.deps, CRON_HOURLY);
    h.setNow(new Date("2026-10-12T16:00:00Z")); // Tue 00:00 SGT
    await runScheduled(h.e, h.deps, CRON_HOURLY);
    expect(await pledges()).toBe(0);

    h.setNow(MON_MIDNIGHT);
    await runScheduled(h.e, h.deps, CRON_HOURLY);
    expect(await pledges()).toBe(1);
    expect((await env.DB.prepare("SELECT period FROM goal_contributions").first<{ period: string }>())!.period).toBe("2026-W41");
    await runScheduled(h.e, h.deps, CRON_HOURLY); // the same hour again
    expect(await pledges()).toBe(1);
    expect(await outbox("underspend_pledge")).toHaveLength(1);
  });

  it("follows the week_start setting (Sunday weeks pledge on Sunday 00:00)", async () => {
    const { h } = setup(new Date("2026-10-10T16:00:00Z")); // Sun 11 Oct 00:00 SGT
    await setBudget(h);
    const g = await goal(h, { name: "Trip" });
    await ok(h, "POST", `/api/goals/${g.id}/underspend`, { on: true });
    await ok(h, "PUT", "/api/settings", { week_start: 0 });
    await runScheduled(h.e, h.deps, CRON_HOURLY);
    expect(await count("SELECT COUNT(*) AS n FROM goal_contributions WHERE source = 'underspend'")).toBe(1);
    h.setNow(MON_MIDNIGHT); // a Monday is not a week start any more
    await runScheduled(h.e, h.deps, CRON_HOURLY);
    expect(await count("SELECT COUNT(*) AS n FROM goal_contributions WHERE source = 'underspend'")).toBe(1);
  });
});

describe("migration 0006", () => {
  it("creates the four goals tables empty and leaves the seeded categories intact", async () => {
    const tables = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%goal%' ORDER BY name").all<{ name: string }>()).results.map((r) => r.name);
    expect(tables).toEqual(["goal_contributions", "goal_funding", "goal_snapshots", "goals"]); // there was no earlier goals table
    for (const t of tables) expect(await count(`SELECT COUNT(*) AS n FROM ${t}`)).toBe(0);
    const idx = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%goal%' ORDER BY name").all<{ name: string }>()).results.map((r) => r.name);
    expect(idx).toEqual(expect.arrayContaining(["uq_goals_underspend", "uq_goal_contrib_underspend", "idx_goal_funding_goal", "idx_goal_contrib_goal"]));
    const groups = (await env.DB.prepare("SELECT id FROM category_groups ORDER BY sort").all<{ id: string }>()).results.map((r) => r.id);
    expect(groups).toEqual(["essentials", "lifestyle", "savings", "income", "transfers"]);
    expect(await count("SELECT COUNT(*) AS n FROM categories WHERE id IN ('groceries','food','coffee')")).toBe(3);
    expect(await count("SELECT COUNT(*) AS n FROM settings WHERE key IN ('base_currency','timezone')")).toBe(2);
  });

  it("the partial unique indexes hold", async () => {
    const { h } = setup();
    const a = await goal(h, { name: "A" });
    const b = await goal(h, { name: "B" });
    const ins = (id: string, goalId: string, period: string, source: string) =>
      env.DB.prepare("INSERT INTO goal_contributions (id, goal_id, period, amount_sgd_minor, source, status, created_at) VALUES (?,?,?,?,?,'pledged','x')").bind(id, goalId, period, 100, source).run();
    await ins("c1", a.id, "2026-W41", "underspend");
    await expect(ins("c2", b.id, "2026-W41", "underspend")).rejects.toThrow();
    await ins("c3", b.id, "2026-W41", "manual");
    await env.DB.prepare("UPDATE goals SET receives_underspend = 1 WHERE id = ?").bind(a.id).run();
    await expect(env.DB.prepare("UPDATE goals SET receives_underspend = 1 WHERE id = ?").bind(b.id).run()).rejects.toThrow();
  });
});

describe("monthly summary", () => {
  it("includes the goals line", async () => {
    const { h } = setup(new Date("2026-11-01T01:00:00Z")); // 1 Nov 09:00 SGT
    const done = await goal(h, { name: "Holiday", target_today_minor: 10000 });
    await ok(h, "POST", `/api/goals/${done.id}/contributions`, { amount_sgd_minor: 10000 });
    await goal(h, { name: "MBA", kind: "mid", target_today_minor: 6000000, target_date: "2030-11-01" });
    const l = await list(h);
    expect(l.summary).toMatch(/^Goals: 1 on track · 1 behind \(MBA −S\$\d/);
    const r = await sendMonthlySummary(h.e, h.deps);
    expect(r.sent).toBe(true);
    expect(r.body).toContain(l.summary!);
    expect(goalsSummaryLine([])).toBeNull();
  });

  it("without goals the summary is unchanged", async () => {
    const { h } = setup(new Date("2026-11-01T01:00:00Z"));
    expect((await sendMonthlySummary(h.e, h.deps)).sent).toBe(false);
  });
});
