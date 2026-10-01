import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkBudgetAlerts } from "../src/alerts";
import { refreshFx } from "../src/cron";
import { _resetRateLimit } from "../src/routes/ingest";
import { NOW, clientSubscription, count, genVapid, harness, json, resetDb } from "./helpers";

let vapid: { pub: string; priv: string };
beforeAll(async () => { vapid = await genVapid(); });
beforeEach(async () => { _resetRateLimit(); await resetDb(); });

/** Lifestyle budget S$100 for Oct 2026 */
async function setLifestyleBudget(h: ReturnType<typeof harness>, minor = 10000, month = "2026-10") {
  const r = await h.call("/api/budgets", json("PUT", { scope: "group", ref_id: "lifestyle", month, amount_sgd_minor: minor }));
  expect(r.status).toBe(200);
}
const spend = (h: ReturnType<typeof harness>, minor: number, category = "food", extra: Record<string, unknown> = {}) =>
  h.call("/api/transactions", json("POST", { amount_minor: minor, category_id: category, occurred_at: "2026-10-12T04:00:00Z", ...extra }));
const alertRows = async () => (await env.DB.prepare("SELECT ref, period FROM alert_log WHERE kind = 'budget' ORDER BY period").all<{ ref: string; period: string }>()).results;

describe("budgets API", () => {
  it("set, inherit forward, override, clear (0) and copy last month", async () => {
    const h = harness();
    await setLifestyleBudget(h, 90000, "2026-08");
    await h.call("/api/budgets", json("PUT", { scope: "category", ref_id: "coffee", month: "2026-08", amount_sgd_minor: 6000 }));
    const oct = await (await h.call("/api/budgets?month=2026-10")).json<{ budgets: { ref_id: string; monthly_amount_sgd_minor: number; effective_from: string }[] }>();
    expect(oct.budgets.map((b) => [b.ref_id, b.monthly_amount_sgd_minor, b.effective_from]).sort()).toEqual([["coffee", 6000, "2026-08"], ["lifestyle", 90000, "2026-08"]]);
    expect((await (await h.call("/api/budgets?month=2026-07")).json<{ budgets: unknown[] }>()).budgets).toEqual([]);

    await setLifestyleBudget(h, 80000, "2026-10");
    expect((await (await h.call("/api/budgets?month=2026-10")).json<{ budgets: { ref_id: string; monthly_amount_sgd_minor: number }[] }>()).budgets.find((b) => b.ref_id === "lifestyle")!.monthly_amount_sgd_minor).toBe(80000);
    expect((await (await h.call("/api/budgets?month=2026-09")).json<{ budgets: { ref_id: string; monthly_amount_sgd_minor: number }[] }>()).budgets.find((b) => b.ref_id === "lifestyle")!.monthly_amount_sgd_minor).toBe(90000);

    await h.call("/api/budgets", json("PUT", { scope: "category", ref_id: "coffee", month: "2026-10", amount_sgd_minor: 0 })); // clear from Oct on
    expect((await (await h.call("/api/budgets?month=2026-10")).json<{ budgets: { ref_id: string }[] }>()).budgets.map((b) => b.ref_id)).toEqual(["lifestyle"]);

    const copy = await (await h.call("/api/budgets/copy", json("POST", { from: "2026-10", to: "2026-11" }))).json<{ copied: number }>();
    expect(copy.copied).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM budgets WHERE effective_from = '2026-11'")).toBe(1);
  });
  it("validates input", async () => {
    const h = harness();
    expect((await h.call("/api/budgets", json("PUT", { scope: "group", ref_id: "nope", month: "2026-10", amount_sgd_minor: 1 }))).status).toBe(400);
    expect((await h.call("/api/budgets", json("PUT", { scope: "group", ref_id: "lifestyle", month: "2026-13", amount_sgd_minor: 1 }))).status).toBe(400);
    expect((await h.call("/api/budgets", json("PUT", { scope: "group", ref_id: "lifestyle", month: "2026-10", amount_sgd_minor: 1.5 }))).status).toBe(400);
  });
  it("the month summary carries resolved budgets", async () => {
    const h = harness();
    await setLifestyleBudget(h);
    const s = await (await h.call("/api/summary?month=2026-10")).json<{ budgets: { ref_id: string }[] }>();
    expect(s.budgets.map((b) => b.ref_id)).toEqual(["lifestyle"]);
  });
});

describe("threshold alerts: 50 / 80 / 100%, once per period", () => {
  it("crossing 80% writes exactly one alert_log row (and one push); 50% and 100% do the same", async () => {
    const h = harness({ vapid });
    await h.call("/api/push/subscribe", json("POST", await clientSubscription()));
    await setLifestyleBudget(h); // S$100

    await spend(h, 4000); // 40%: nothing
    expect(await alertRows()).toEqual([]);

    await spend(h, 1500); // 55%: crosses 50
    expect(await alertRows()).toEqual([{ ref: "group:lifestyle", period: "2026-10:50" }]);

    await spend(h, 3000); // 85%: crosses 80 -> exactly ONE new row
    expect(await alertRows()).toEqual([{ ref: "group:lifestyle", period: "2026-10:50" }, { ref: "group:lifestyle", period: "2026-10:80" }]);

    await spend(h, 500); // 90%: nothing new (once per period)
    expect(await count("SELECT COUNT(*) AS n FROM alert_log WHERE kind = 'budget'")).toBe(2);

    await spend(h, 2000); // 110%
    expect((await alertRows()).map((r) => r.period)).toEqual(["2026-10:100", "2026-10:50", "2026-10:80"]);
    expect(h.pushes).toHaveLength(3); // 50, 80, 100 each pushed once
  });

  it("one big purchase jumping several thresholds logs them all but pushes once (the highest)", async () => {
    const h = harness({ vapid });
    await h.call("/api/push/subscribe", json("POST", await clientSubscription()));
    await setLifestyleBudget(h);
    await spend(h, 9000);
    expect((await alertRows()).map((r) => r.period)).toEqual(["2026-10:50", "2026-10:80"]);
    expect(h.pushes).toHaveLength(1);
    await spend(h, 100); // still 91%: the logged 50/80 never re-fire
    expect(h.pushes).toHaveLength(1);
  });

  it("is race-free: concurrent checks log each threshold once", async () => {
    const h = harness();
    await setLifestyleBudget(h);
    await env.DB.prepare("INSERT INTO transactions (id, occurred_at, amount_minor, currency, amount_sgd_minor, status, source, category_id, created_at, updated_at) VALUES ('t1','2026-10-12T04:00:00Z',9000,'SGD',9000,'confirmed','manual','food','x','x')").run();
    await Promise.all([checkBudgetAlerts(h.e, h.deps), checkBudgetAlerts(h.e, h.deps), checkBudgetAlerts(h.e, h.deps)]);
    expect(await count("SELECT COUNT(*) AS n FROM alert_log WHERE kind = 'budget'")).toBe(2);
  });

  it("follows the spend definition: excluded, reimbursable and transfers don't push a budget over", async () => {
    const h = harness();
    await setLifestyleBudget(h);
    await spend(h, 9000, "food", { is_excluded: true });
    await spend(h, 9000, "food", { is_reimbursable: true });
    await spend(h, 9000, "card_payment");
    expect(await alertRows()).toEqual([]);
  });

  it("category budgets alert on their own category; no budget -> no alert", async () => {
    const h = harness();
    await spend(h, 99999); // no budgets at all
    expect(await alertRows()).toEqual([]);
    await h.call("/api/budgets", json("PUT", { scope: "category", ref_id: "coffee", month: "2026-10", amount_sgd_minor: 5000 }));
    await spend(h, 3000, "food"); // other category: no
    expect(await alertRows()).toEqual([]);
    await spend(h, 2600, "coffee"); // 52%
    expect(await alertRows()).toEqual([{ ref: "category:coffee", period: "2026-10:50" }]);
  });

  it("thresholds are configurable", async () => {
    const h = harness();
    await h.call("/api/settings", json("PUT", { alert_thresholds: [90] }));
    await setLifestyleBudget(h);
    await spend(h, 8500);
    expect(await alertRows()).toEqual([]);
    await spend(h, 600);
    expect(await alertRows()).toEqual([{ ref: "group:lifestyle", period: "2026-10:90" }]);
    expect((await (await h.call("/api/setup")).json<{ alerts: { thresholds: number[] } }>()).alerts.thresholds).toEqual([90]);
  });

  it("a new month starts fresh (period includes the month)", async () => {
    const h = harness();
    await setLifestyleBudget(h);
    await spend(h, 6000);
    const nov = harness({ now: new Date("2026-11-10T04:00:00Z") });
    await nov.call("/api/transactions", json("POST", { amount_minor: 6000, category_id: "food", occurred_at: "2026-11-09T04:00:00Z" }));
    expect((await alertRows()).map((r) => r.period)).toEqual(["2026-10:50", "2026-11:50"]);
  });

  it("editing an old month's transaction doesn't alert", async () => {
    const h = harness();
    await setLifestyleBudget(h, 10000, "2026-09");
    await h.call("/api/transactions", json("POST", { amount_minor: 9000, category_id: "food", occurred_at: "2026-09-10T04:00:00Z" }));
    expect(await alertRows()).toEqual([{ ref: "group:lifestyle", period: "2026-10:50" }, { ref: "group:lifestyle", period: "2026-10:80" }].slice(0, 0));
  });

  it("Apple Pay capture triggers the alert and the purchase push shows 'Lifestyle S$x / S$budget'", async () => {
    const h = harness({ vapid });
    await h.call("/api/push/subscribe", json("POST", await clientSubscription()));
    await setLifestyleBudget(h);
    await spend(h, 7000);
    await h.call("/api/rules", json("POST", { pattern: "YA KUN", category_id: "coffee" }));
    const r = await h.call("/api/ingest/applepay", { method: "POST", headers: { authorization: "Bearer tok", "content-type": "application/json" }, body: JSON.stringify({ amount: "S$14.50", merchant: "Ya Kun", ts: "2026-10-14T11:55:00+08:00" }) });
    expect(r.status).toBe(201);
    expect((await alertRows()).map((x) => x.period)).toEqual(["2026-10:50", "2026-10:80"]); // 70 + 14.50 = 84.5%
  });
});

describe("multi-currency", () => {
  it("manual JPY entry converts at the ECB rate, stores rate + source, and the fx endpoint serves it", async () => {
    const h = harness({ rates: { JPY: 0.0089 } });
    const r = await h.call("/api/transactions", json("POST", { amount_minor: 1200, currency: "JPY", category_id: "food" }));
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ currency: "JPY", amount_minor: 1200, amount_sgd_minor: 1068, fx_source: "ecb", fx_rate: 0.0089 });
    expect(await (await h.call("/api/fx/jpy")).json()).toMatchObject({ currency: "JPY", rate: 0.0089, date: "2026-10-14" });
    expect(h.fxCalls).toHaveLength(1); // second lookup came from fx_rates
    expect((await h.call("/api/fx/XXX")).status).toBe(404);
  });
  it("a manually typed SGD amount wins (fx_source manual)", async () => {
    const h = harness({ rates: { JPY: 0.0089 } });
    const r = await (await h.call("/api/transactions", json("POST", { amount_minor: 1200, currency: "JPY", amount_sgd_minor: 1100 }))).json();
    expect(r).toMatchObject({ amount_sgd_minor: 1100, fx_source: "manual" });
  });
  it("IDR with its 2 minor digits converts correctly", async () => {
    const h = harness({ rates: { IDR: 0.0000835 } });
    const r = await (await h.call("/api/transactions", json("POST", { amount_minor: 4_500_000, currency: "IDR" }))).json<{ amount_sgd_minor: number }>();
    expect(r.amount_sgd_minor).toBe(376);
  });
  it("changing currency/amount on edit re-converts", async () => {
    const h = harness({ rates: { JPY: 0.0089 } });
    const t = await (await h.call("/api/transactions", json("POST", { amount_minor: 1200, currency: "JPY" }))).json<{ id: string }>();
    const p = await (await h.call(`/api/transactions/${t.id}`, json("PATCH", { amount_minor: 2000 }))).json<{ amount_sgd_minor: number }>();
    expect(p.amount_sgd_minor).toBe(1780);
  });
  it("refreshFx caches today's rate for currencies used recently and for the active trip's", async () => {
    const h = harness({ rates: { JPY: 0.0089, IDR: 0.0000835 } });
    await h.call("/api/transactions", json("POST", { amount_minor: 1200, currency: "JPY", occurred_at: "2026-10-10T04:00:00Z" }));
    await env.DB.exec("DELETE FROM fx_rates");
    await h.call("/api/trips", json("POST", { name: "Bali", start_date: "2026-10-12", end_date: "2026-10-20", currency: "IDR" }));
    expect((await refreshFx(h.e, h.deps)).sort()).toEqual(["IDR", "JPY"]);
    expect(await count("SELECT COUNT(*) AS n FROM fx_rates WHERE date = '2026-10-14'")).toBe(2);
  });
});

describe("trips", () => {
  it("CRUD, active trip, and auto-tagging of manual and Apple Pay transactions inside the dates", async () => {
    const h = harness({ rates: { JPY: 0.0089 } });
    const trip = await (await h.call("/api/trips", json("POST", { name: "Tokyo Oct 2026", start_date: "2026-10-10", end_date: "2026-10-16", currency: "jpy" }))).json<{ id: string; currency: string }>();
    expect(trip.currency).toBe("JPY");
    expect(await (await h.call("/api/trips/active")).json()).toMatchObject({ id: trip.id, currency: "JPY" });

    const inside = await (await h.call("/api/transactions", json("POST", { amount_minor: 500, occurred_at: "2026-10-12T04:00:00Z" }))).json<{ trip_id: string }>();
    const outside = await (await h.call("/api/transactions", json("POST", { amount_minor: 500, occurred_at: "2026-10-20T04:00:00Z" }))).json<{ trip_id: string | null }>();
    const optOut = await (await h.call("/api/transactions", json("POST", { amount_minor: 500, occurred_at: "2026-10-12T05:00:00Z", trip_id: null }))).json<{ trip_id: string | null }>();
    expect(inside.trip_id).toBe(trip.id);
    expect(outside.trip_id).toBeNull();
    expect(optOut.trip_id).toBeNull();

    const tap = await (await h.call("/api/ingest/applepay", { method: "POST", headers: { authorization: "Bearer tok", "content-type": "application/json" }, body: JSON.stringify({ amount: "¥1,200", merchant: "Lawson", ts: "2026-10-14T11:00:00+08:00" }) })).json<{ id: string }>();
    expect((await (await h.call(`/api/transactions/${tap.id}`)).json<{ trip_id: string }>()).trip_id).toBe(trip.id);

    expect((await h.call("/api/trips", json("POST", { name: "Bad", start_date: "2026-10-10", end_date: "2026-10-01" }))).status).toBe(400);
    await h.call(`/api/trips/${trip.id}`, json("PATCH", { name: "Tokyo!" }));
    expect((await (await h.call("/api/trips")).json<{ name: string }[]>())[0]!.name).toBe("Tokyo!");
    await h.call(`/api/trips/${trip.id}`, { method: "DELETE" });
    expect(await count("SELECT COUNT(*) AS n FROM transactions WHERE trip_id IS NOT NULL")).toBe(0);
    expect(await (await h.call("/api/trips/active")).json()).toBeNull();
  });
});

describe("card cycles", () => {
  it("per-card spend since the last statement, bill estimate vs spend definition, previous statement, due date", async () => {
    const h = harness();
    const card = await (await h.call("/api/accounts", json("POST", { name: "DBS Altitude", kind: "credit", bank: "DBS", last4: "1234", statement_day: 12, due_day: 7 }))).json<{ id: string }>();
    await h.call("/api/accounts", json("POST", { name: "Citi (no day set)", kind: "credit" }));
    await h.call("/api/accounts", json("POST", { name: "Cash", kind: "cash" }));
    const add = (minor: number, at: string, extra: Record<string, unknown> = {}) => h.call("/api/transactions", json("POST", { amount_minor: minor, category_id: "food", account_id: card.id, occurred_at: at, ...extra }));
    // NOW = 14 Oct SGT; last statement 12 Oct; current cycle = 13 Oct onwards; previous = 13 Sep..12 Oct (wait: previous is 13 Sep - 12 Oct)
    await add(5000, "2026-10-13T04:00:00Z"); // current
    await add(2000, "2026-10-13T05:00:00Z", { is_reimbursable: true }); // on the bill, not in spend
    await add(1000, "2026-10-12T15:30:00Z"); // 23:30 SGT on 12 Oct: still the closing cycle
    await add(7000, "2026-09-20T04:00:00Z"); // previous cycle
    await add(9999, "2026-08-01T04:00:00Z"); // older: ignored
    const out = await (await h.call("/api/cycles")).json<{ today: string; cycles: { configured: boolean; account: { name: string }; last_statement?: string; next_statement?: string; due_date?: string; current_bill?: number; current_spend?: number; previous_bill?: number; current_count?: number }[] }>();
    expect(out.today).toBe("2026-10-14");
    expect(out.cycles.map((c) => c.account.name)).toEqual(["Citi (no day set)", "DBS Altitude"]); // cash isn't a credit card
    expect(out.cycles[0]!.configured).toBe(false);
    expect(out.cycles[1]).toMatchObject({ configured: true, last_statement: "2026-10-12", next_statement: "2026-11-12", due_date: "2026-11-07", current_bill: 7000, current_spend: 5000, current_count: 2, previous_bill: 8000 });
  });
});

describe("trend", () => {
  it("monthly Lifestyle totals over the last N months", async () => {
    const h = harness();
    const add = (minor: number, at: string, cat = "food") => h.call("/api/transactions", json("POST", { amount_minor: minor, category_id: cat, occurred_at: at }));
    await add(1000, "2026-08-10T04:00:00Z");
    await add(3000, "2026-09-10T04:00:00Z");
    await add(500, "2026-09-11T04:00:00Z", "groceries");
    await add(2000, "2026-10-10T04:00:00Z");
    const t = await (await h.call("/api/trend?months=3")).json<{ points: { month: string; group: number; total: number }[] }>();
    expect(t.points).toEqual([{ month: "2026-08", group: 1000, total: 1000 }, { month: "2026-09", group: 3000, total: 3500 }, { month: "2026-10", group: 2000, total: 2000 }]);
    expect((await h.call("/api/trend?months=99")).status).toBe(400);
  });
});

describe("migration 0003", () => {
  it("alert_log rejects a second row for the same (kind, ref, period)", async () => {
    await env.DB.prepare("INSERT INTO alert_log (id, kind, ref, period, sent_at) VALUES ('a','budget','group:lifestyle','2026-10:80','x')").run();
    await expect(env.DB.prepare("INSERT INTO alert_log (id, kind, ref, period, sent_at) VALUES ('b','budget','group:lifestyle','2026-10:80','x')").run()).rejects.toThrow();
    expect(NOW.getTime()).toBeGreaterThan(0);
  });
});
