import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CRON_DAILY, CRON_HOURLY, CRON_WEEKLY, runScheduled } from "../src/cron";
import { sendWeeklyDigest } from "../src/digest";
import { runSubscriptionDetection as runRecurringDetection } from "../src/subscriptions";
import { _resetRateLimit } from "../src/routes/ingest";
import { clientSubscription, count, genVapid, harness, json, resetDb } from "./helpers";

let vapid: { pub: string; priv: string };
beforeAll(async () => { vapid = await genVapid(); });
beforeEach(async () => { _resetRateLimit(); await resetDb(); });

const add = (h: ReturnType<typeof harness>, o: Record<string, unknown>) => h.call("/api/transactions", json("POST", o));

describe("subscriptions (recurring detection)", () => {
  async function seedNetflix(h: ReturnType<typeof harness>) {
    for (const d of ["2026-07-12", "2026-08-12", "2026-09-12"]) await add(h, { amount_minor: 1998, category_id: "subscriptions", merchant: "Netflix", occurred_at: `${d}T04:00:00Z` });
    await add(h, { amount_minor: 450, category_id: "coffee", merchant: "Starbucks", occurred_at: "2026-09-12T04:00:00Z" }); // one-off
  }
  it("detects, links transactions, totals the month, confirm and dismiss; dismissed ones never come back", async () => {
    const h = harness();
    await seedNetflix(h);
    expect(await runRecurringDetection(h.e, h.deps)).toEqual({ added: 1, updated: 0 });
    const list = await (await h.call("/api/subscriptions")).json<{ items: { id: string; merchant: string; expected_amount_sgd_minor: number; next_expected: string; confirmed_by_user: number }[]; monthly_total: number; confirmed_total: number }>();
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ merchant: "NETFLIX", expected_amount_sgd_minor: 1998, next_expected: "2026-10-12", confirmed_by_user: 0 });
    expect(list.monthly_total).toBe(1998);
    expect(list.confirmed_total).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM transactions WHERE recurring_id IS NOT NULL")).toBe(3);

    const id = list.items[0]!.id;
    await h.call(`/api/subscriptions/${id}/confirm`, { method: "POST" });
    expect((await (await h.call("/api/subscriptions")).json<{ confirmed_total: number }>()).confirmed_total).toBe(1998);
    expect(await runRecurringDetection(h.e, h.deps)).toEqual({ added: 0, updated: 1 }); // refresh, no duplicate row

    await h.call(`/api/subscriptions/${id}/dismiss`, { method: "POST" });
    expect((await (await h.call("/api/subscriptions")).json<{ items: unknown[] }>()).items).toEqual([]);
    expect(await count("SELECT COUNT(*) AS n FROM transactions WHERE recurring_id IS NOT NULL")).toBe(0);
    expect(await runRecurringDetection(h.e, h.deps)).toEqual({ added: 0, updated: 0 }); // not resurrected
    expect((await h.call("/api/subscriptions/nope/confirm", { method: "POST" })).status).toBe(404);
  });
  it("excluded / reimbursable charges and refunds are not subscriptions; the daily cron runs detection", async () => {
    const h = harness();
    for (const d of ["2026-07-12", "2026-08-12", "2026-09-12"]) await add(h, { amount_minor: 5000, category_id: "subscriptions", merchant: "Work SaaS", occurred_at: `${d}T04:00:00Z`, is_reimbursable: true });
    await runScheduled(h.e, h.deps, CRON_DAILY);
    expect(await count("SELECT COUNT(*) AS n FROM subscriptions")).toBe(0);
    await seedNetflix(h);
    await runScheduled(h.e, h.deps, CRON_DAILY);
    expect(await count("SELECT COUNT(*) AS n FROM subscriptions")).toBe(1);
  });
});

describe("weekly digest (Sunday 20:00 SGT)", () => {
  const SUNDAY = new Date("2026-10-11T12:00:00Z"); // Sun 11 Oct 20:00 SGT; week = Mon 5 Oct .. Sun 11 Oct
  async function seed(h: ReturnType<typeof harness>) {
    await h.call("/api/budgets", json("PUT", { scope: "group", ref_id: "lifestyle", month: "2026-10", amount_sgd_minor: 90000 }));
    await add(h, { amount_minor: 12800, category_id: "shopping", merchant: "Uniqlo", occurred_at: "2026-10-06T04:00:00Z" });
    await add(h, { amount_minor: 9600, category_id: "groceries", merchant: "NTUC Fairprice", occurred_at: "2026-10-08T04:00:00Z" });
    await add(h, { amount_minor: 7800, category_id: "food", merchant: "Din Tai Fung", occurred_at: "2026-10-10T04:00:00Z" });
    await add(h, { amount_minor: 500, category_id: "coffee", merchant: "Kopi", occurred_at: "2026-10-10T05:00:00Z" });
    await add(h, { amount_minor: 99999, category_id: "shopping", merchant: "Last Week Splurge", occurred_at: "2026-10-03T04:00:00Z" }); // previous week
    await add(h, { amount_minor: 3000, category_id: "card_payment", merchant: "Card Payment", occurred_at: "2026-10-09T04:00:00Z" }); // transfer: not spend
  }
  it("pushes week total, Lifestyle vs pace and the biggest 3 purchases, once per week", async () => {
    const h = harness({ vapid, now: SUNDAY });
    await h.call("/api/push/subscribe", json("POST", await clientSubscription()));
    await h.call("/api/settings", json("PUT", { nudge_daily_limit: 20 })); // seeding trips budget alerts; keep the gate out of this test
    await seed(h);
    h.pushes.length = 0;
    const out = await sendWeeklyDigest(h.e, h.deps);
    expect(out.sent).toBe(true);
    // week spend = 128 + 96 + 78 + 5 = 307; lifestyle MTD = 128 + 78 + 5 + 999.99 (all October lifestyle) ; pace on day 11 of 31
    expect(out.body).toContain("This week S$307");
    expect(out.body).toContain("Biggest: Uniqlo S$128, Ntuc Fairprice S$96, Din Tai Fung S$78");
    expect(out.body).toContain("/ S$900 (pace S$319)"); // floor(90000 * 11 / 31) = 31935 -> S$319
    expect(out.body).not.toContain("Splurge");
    // Lifestyle this week (5-11 Oct) = 128 + 78 + 5 = S$211; usual = the one complete earlier week with data (28 Sep-4 Oct: the S$999.99 splurge)
    expect(out.body).toMatch(/ · Lifestyle this week S\$211 · usual S\$1,?000$/);
    expect(h.pushes).toHaveLength(1);
    expect((await sendWeeklyDigest(h.e, h.deps)).sent).toBe(false); // already sent this week
    expect(await count("SELECT COUNT(*) AS n FROM alert_log WHERE kind = 'weekly_digest'")).toBe(1);
  });
  it("can be switched off, and the weekly cron dispatches to it", async () => {
    const h = harness({ vapid, now: SUNDAY });
    await h.call("/api/settings", json("PUT", { push_weekly_digest: false }));
    expect((await sendWeeklyDigest(h.e, h.deps)).sent).toBe(false);
    await h.call("/api/settings", json("PUT", { push_weekly_digest: true }));
    await runScheduled(h.e, h.deps, CRON_WEEKLY);
    expect(await count("SELECT COUNT(*) AS n FROM alert_log WHERE kind = 'weekly_digest'")).toBe(1);
    expect((await (await h.call("/api/setup")).json<{ push: { weekly_digest: boolean } }>()).push.weekly_digest).toBe(true);
  });
  it("hourly cron doesn't send the digest", async () => {
    const h = harness({ vapid, now: SUNDAY });
    await runScheduled(h.e, h.deps, CRON_HOURLY);
    expect(await count("SELECT COUNT(*) AS n FROM alert_log WHERE kind = 'weekly_digest'")).toBe(0);
  });
});

describe("CSV export", () => {
  it("exports decimals (never floats), SGT date/time, names, BOM, and neutralises formulas", async () => {
    const h = harness();
    await add(h, { amount_minor: 1450, category_id: "coffee", merchant: "=HYPERLINK(\"http://evil\")", occurred_at: "2026-10-12T15:30:00Z", note: "a \"quoted\", note" }); // 23:30 SGT on 12 Oct
    await add(h, { amount_minor: 1200, currency: "JPY", amount_sgd_minor: 1068, category_id: "food", occurred_at: "2026-09-01T04:00:00Z", is_refund: true });
    const res = await h.call("/api/export/transactions.csv");
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("okanary-transactions-2026-10-14.csv");
    const text = await res.text();
    expect(text.startsWith("﻿id,date_sgt,time_sgt")).toBe(true);
    const lines = text.slice(1).trim().split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain(",2026-10-12,23:30,");
    expect(lines[2]).toContain("Coffee/Snacks");
    expect(lines[2]).toContain(",14.50,SGD,14.50,");
    expect(lines[2]).toContain("\"'=HYPERLINK(");
    expect(lines[2]).toContain('"a ""quoted"", note"');
    expect(lines[1]).toContain(",1200,JPY,10.68,");
    expect(lines[1]).toContain(",yes,"); // refund flag
    const filtered = await (await h.call("/api/export/transactions.csv?from=2026-10-01&to=2026-10-31")).text();
    expect(filtered.trim().split("\r\n")).toHaveLength(2);
    expect((await h.call("/api/export/transactions.csv?from=nope")).status).toBe(400);
  });
});

describe("statement import & reconcile", () => {
  const CSV = [
    "Statement of account,,",
    "Transaction Date,Description,Amount",
    "13/09/2026,YA KUN KAYA TOAST SINGAPORE SG,14.50", // matches the Apple Pay tap
    "14/09/2026,LAWSON SHIBUYA TOKYO JP,11.12", // FX estimate was S$10.68
    "15/09/2026,NEW ONLINE SHOP,99.00", // missing from our records
    "16/09/2026,SPOTIFY,9.98", // missing, a rule knows it
    "20/09/2026,PAYMENT - THANK YOU,-500.00", // card payment: ignored
  ].join("\n");

  async function setup() {
    const h = harness({ rates: { JPY: 0.0089 } });
    const card = await (await h.call("/api/accounts", json("POST", { name: "DBS Altitude", kind: "credit", last4: "1234" }))).json<{ id: string }>();
    await h.call("/api/rules", json("POST", { pattern: "SPOTIFY", category_id: "subscriptions" }));
    const tap = await add(h, { amount_minor: 1450, merchant: "SQ *YA KUN KAYA TOAST", category_id: "coffee", account_id: card.id, occurred_at: "2026-09-12T04:00:00Z" });
    await env.DB.prepare("UPDATE transactions SET status = 'pending', source = 'applepay' WHERE id = ?").bind((await tap.json<{ id: string }>()).id).run();
    const jpy = await (await add(h, { amount_minor: 1200, currency: "JPY", merchant: "Lawson Shibuya", category_id: "food", account_id: card.id, occurred_at: "2026-09-13T04:00:00Z" })).json<{ id: string; amount_sgd_minor: number }>();
    expect(jpy.amount_sgd_minor).toBe(1068);
    await add(h, { amount_minor: 777, merchant: "Not On The Statement", category_id: "food", account_id: card.id, occurred_at: "2026-09-14T04:00:00Z" });
    return { h, card: card.id, jpyId: jpy.id };
  }
  const run = async (h: ReturnType<typeof harness>, account_id: string, commit: boolean, text = CSV) => {
    const r = await h.call("/api/import/statement", json("POST", { account_id, text, commit }));
    return { status: r.status, body: await r.json<any>() };
  };

  it("previews without changing anything", async () => {
    const { h, card } = await setup();
    const before = await count("SELECT COUNT(*) AS n FROM transactions");
    const { status, body } = await run(h, card, false);
    expect(status).toBe(200);
    expect(body.matched.map((m: any) => [m.description, m.correct_sgd_to])).toEqual([["YA KUN KAYA TOAST SINGAPORE SG", null], ["LAWSON SHIBUYA TOKYO JP", 1112]]);
    expect(body.to_add.map((r: any) => r.description)).toEqual(["NEW ONLINE SHOP", "SPOTIFY"]);
    expect(body.payments).toHaveLength(1);
    expect(body.not_on_statement.map((n: any) => n.merchant)).toEqual(["NOT ON THE STATEMENT"]);
    expect(body.applied).toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM transactions")).toBe(before);
  });

  it("commit: corrects billed SGD (fx_source statement), confirms pending, adds missing as import (rule-categorised), skips payments, never deletes", async () => {
    const { h, card, jpyId } = await setup();
    const { body } = await run(h, card, true);
    expect(body.applied).toEqual({ corrected: 1, confirmed: 1, added: 2 });
    const jpy = await env.DB.prepare("SELECT amount_minor, amount_sgd_minor, fx_source, fx_rate, status FROM transactions WHERE id = ?").bind(jpyId).first<any>();
    expect(jpy).toMatchObject({ amount_minor: 1200, amount_sgd_minor: 1112, fx_source: "statement", status: "confirmed" });
    expect(jpy.fx_rate).toBeCloseTo(1112 / 1200, 6);
    expect(await env.DB.prepare("SELECT status FROM transactions WHERE merchant = 'YA KUN KAYA TOAST'").first()).toEqual({ status: "confirmed" });
    const imported = (await env.DB.prepare("SELECT merchant, amount_sgd_minor, category_id, category_source, source, status, occurred_at FROM transactions WHERE source = 'import' ORDER BY merchant").all<any>()).results;
    expect(imported).toEqual([
      { merchant: "NEW ONLINE SHOP", amount_sgd_minor: 9900, category_id: null, category_source: null, source: "import", status: "confirmed", occurred_at: "2026-09-15T04:00:00.000Z" },
      { merchant: "SPOTIFY", amount_sgd_minor: 998, category_id: "subscriptions", category_source: "rule", source: "import", status: "confirmed", occurred_at: "2026-09-16T04:00:00.000Z" },
    ]);
    expect(await count("SELECT COUNT(*) AS n FROM transactions WHERE merchant = 'NOT ON THE STATEMENT'")).toBe(1); // kept
    expect(await count("SELECT COUNT(*) AS n FROM raw_ingest WHERE source = 'import'")).toBe(1);
  });

  it("is idempotent: importing the same statement again changes nothing", async () => {
    const { h, card } = await setup();
    await run(h, card, true);
    const n = await count("SELECT COUNT(*) AS n FROM transactions");
    const again = await run(h, card, true);
    expect(again.body.applied).toEqual({ corrected: 0, confirmed: 0, added: 0 });
    expect(await count("SELECT COUNT(*) AS n FROM transactions")).toBe(n);
  });

  it("the corrected amount flows into the month total", async () => {
    const { h, card } = await setup();
    const before = (await (await h.call("/api/summary?month=2026-09")).json<{ total: number }>()).total;
    await run(h, card, true);
    const after = (await (await h.call("/api/summary?month=2026-09")).json<{ total: number }>()).total;
    expect(after - before).toBe(1112 - 1068 + 9900 + 998);
  });

  it("validation: unknown account, empty/unreadable text, too many rows", async () => {
    const { h, card } = await setup();
    expect((await run(h, "nope", false)).status).toBe(400);
    expect((await h.call("/api/import/statement", json("POST", { account_id: card, text: "" }))).status).toBe(400);
    const empty = await run(h, card, true, "this is not a statement at all");
    expect(empty.body).toMatchObject({ matched: [], to_add: [], applied: { added: 0 } });
    const huge = "Date,Description,Amount\n" + Array.from({ length: 301 }, (_, i) => `01/09/2026,SHOP ${i},1.00`).join("\n");
    const r = await run(h, card, false, huge);
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("too many rows");
  });

  it("imported lines are auto-tagged to the trip covering their date (so trip exclusion still applies)", async () => {
    const { h, card } = await setup();
    await h.call("/api/trips", json("POST", { name: "Tokyo", start_date: "2026-09-16", end_date: "2026-09-17", exclude_from_monthly: true }));
    await run(h, card, true);
    const rows = (await env.DB.prepare("SELECT merchant, trip_id IS NOT NULL AS tagged FROM transactions WHERE source = 'import' ORDER BY merchant").all<{ merchant: string; tagged: number }>()).results;
    expect(rows).toEqual([{ merchant: "NEW ONLINE SHOP", tagged: 0 }, { merchant: "SPOTIFY", tagged: 1 }]); // 15 Sep is outside, 16 Sep inside
  });

  it("a foreign purchase typed in as an SGD guess is corrected, not duplicated", async () => {
    const h = harness();
    const card = await (await h.call("/api/accounts", json("POST", { name: "DBS", kind: "credit" }))).json<{ id: string }>();
    await add(h, { amount_minor: 80000, merchant: "Don Quijote", category_id: "shopping", account_id: card.id, occurred_at: "2026-10-02T03:00:00Z" });
    const { body } = await run(h, card.id, true, "Transaction Date,Description,Amount\n02/10/2026,DON QUIJOTE SHIBUYA JP,812.40");
    expect(body.applied).toEqual({ corrected: 1, confirmed: 0, added: 0 });
    expect(await count("SELECT COUNT(*) AS n FROM transactions")).toBe(1);
    expect(await env.DB.prepare("SELECT amount_sgd_minor, amount_minor, fx_source FROM transactions").first()).toEqual({ amount_sgd_minor: 81240, amount_minor: 81240, fx_source: "same" });
  });

  it("PDF-style pasted text works too", async () => {
    const { h, card } = await setup();
    const { body } = await run(h, card, true, "12 SEP 13 SEP YA KUN KAYA TOAST SINGAPORE SG 14.50\n15 SEP NEW ONLINE SHOP 99.00");
    expect(body.mode).toBe("text");
    expect(body.applied).toMatchObject({ added: 1 });
  });
});

describe("trips: exclude from monthly", () => {
  it("hides a trip's spend from monthly totals, budgets and alerts but keeps it in the trip total and the card bill", async () => {
    const h = harness();
    const card = await (await h.call("/api/accounts", json("POST", { name: "DBS", kind: "credit", statement_day: 12, due_day: 7 }))).json<{ id: string }>();
    const trip = await (await h.call("/api/trips", json("POST", { name: "Tokyo", start_date: "2026-10-01", end_date: "2026-10-10", exclude_from_monthly: true }))).json<{ id: string; exclude_from_monthly: number }>();
    expect(trip.exclude_from_monthly).toBe(1);
    await h.call("/api/budgets", json("PUT", { scope: "group", ref_id: "lifestyle", month: "2026-10", amount_sgd_minor: 10000 }));
    await add(h, { amount_minor: 50000, category_id: "shopping", account_id: card.id, occurred_at: "2026-10-05T04:00:00Z" }); // on the trip
    await add(h, { amount_minor: 2000, category_id: "food", account_id: card.id, occurred_at: "2026-10-12T04:00:00Z" }); // home
    const s = await (await h.call("/api/summary?month=2026-10")).json<{ total: number; byGroup: { id: string; spent: number }[] }>();
    expect(s.total).toBe(2000);
    expect(s.byGroup.find((g) => g.id === "lifestyle")!.spent).toBe(2000);
    expect(await count("SELECT COUNT(*) AS n FROM alert_log WHERE kind = 'budget'")).toBe(0); // S$500 trip spend didn't blow the S$100 budget

    const ts = await (await h.call(`/api/trips/${trip.id}/summary`)).json<{ total: number; count: number; byCategory: { id: string; spent: number }[] }>();
    expect(ts).toMatchObject({ total: 50000, count: 1 });
    expect(ts.byCategory[0]).toEqual({ id: "shopping", spent: 50000, count: 1 });
    const list = await (await h.call("/api/trips")).json<{ spent_sgd_minor: number; count: number }[]>();
    expect(list[0]).toMatchObject({ spent_sgd_minor: 50000, count: 1 });

    const cyc = await (await h.call("/api/cycles")).json<{ cycles: { previous_bill: number }[] }>();
    expect(cyc.cycles[0]).toMatchObject({ previous_bill: 52000 }); // the last statement's bill still includes the trip (and the 12 Oct purchase, closing day)

    const tripTxns = await (await h.call(`/api/transactions?trip=${trip.id}`)).json<unknown[]>();
    expect(tripTxns).toHaveLength(1);

    // turn the flag off: the spend returns to the month
    await h.call(`/api/trips/${trip.id}`, json("PATCH", { exclude_from_monthly: false }));
    expect((await (await h.call("/api/summary?month=2026-10")).json<{ total: number }>()).total).toBe(52000);
  });
});

describe("trend by category", () => {
  it("returns monthly totals for one category", async () => {
    const h = harness();
    await add(h, { amount_minor: 500, category_id: "coffee", occurred_at: "2026-09-10T04:00:00Z" });
    await add(h, { amount_minor: 700, category_id: "coffee", occurred_at: "2026-10-10T04:00:00Z" });
    await add(h, { amount_minor: 9999, category_id: "food", occurred_at: "2026-10-10T04:00:00Z" });
    const t = await (await h.call("/api/trend?months=2&category=coffee")).json<{ group: string; points: { month: string; group: number }[] }>();
    expect(t.group).toBe("coffee");
    expect(t.points.map((p) => [p.month, p.group])).toEqual([["2026-09", 500], ["2026-10", 700]]);
  });
});
