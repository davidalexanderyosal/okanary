import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { CRON_HOURLY, CRON_NETWORTH, runScheduled } from "../src/cron";
import { loadCardLiabilities, runNetworthJob } from "../src/networth-job";
import { sendMonthlySummary } from "../src/networth-summary";
import { _resetRateLimit } from "../src/routes/ingest";
import { count, harness, json, resetDb } from "./helpers";

beforeEach(async () => { _resetRateLimit(); await resetDb(); });

// ---- time (all SGT) ----
const D1 = new Date("2026-10-13T22:30:00Z"); // 14 Oct 06:30 SGT (the cron time)
const D2 = new Date("2026-10-14T22:30:00Z"); // 15 Oct 06:30 SGT
const NOON14 = new Date("2026-10-14T04:00:00Z"); // 14 Oct 12:00 SGT

/** A mocked market: per-test tables answering Finnhub / Alpha Vantage / CoinGecko, recording every call. */
function market() {
  const m = {
    finnhub: {} as Record<string, unknown>, // symbol -> JSON body | HTTP status number
    av: {} as Record<string, unknown>,
    cg: null as Record<string, unknown> | null,
    calls: [] as { url: string; headers: Record<string, string> }[],
  };
  const onFetch = (u: string, init?: RequestInit): Response | undefined => {
    const url = new URL(u);
    const rec = () => m.calls.push({ url: u, headers: (init?.headers ?? {}) as Record<string, string> });
    if (url.hostname === "finnhub.io") {
      rec();
      const v = m.finnhub[url.searchParams.get("symbol")!];
      if (v === undefined || typeof v === "number") return new Response("err", { status: typeof v === "number" ? v : 500 });
      return Response.json(v);
    }
    if (url.hostname === "www.alphavantage.co") {
      rec();
      const v = m.av[url.searchParams.get("symbol")!];
      return v === undefined ? new Response("err", { status: 500 }) : Response.json(v);
    }
    if (url.hostname === "api.coingecko.com") {
      rec();
      return m.cg ? Response.json(m.cg) : new Response("err", { status: 429 });
    }
    return undefined;
  };
  const calls = (host: string) => m.calls.filter((c) => new URL(c.url).hostname === host);
  const av = (price: string, prev: string) => ({ "Global Quote": { "05. price": price, "08. previous close": prev } });
  return { m, onFetch, calls, av };
}

type H = ReturnType<typeof harness>;
function setup(now: Date, opts: { keys?: boolean; rates?: Record<string, number> } = {}) {
  const mk = market();
  const h = harness({ now, rates: opts.rates ?? { USD: 1.3 }, onFetch: mk.onFetch });
  if (opts.keys !== false) { h.e.FINNHUB_API_KEY = "fk"; h.e.ALPHAVANTAGE_API_KEY = "ak"; h.e.COINGECKO_API_KEY = "ck"; }
  return { h, ...mk };
}

const post = async <T = Record<string, unknown>>(h: H, path: string, body: unknown): Promise<T> => {
  const r = await h.call(path, json("POST", body));
  expect(r.status, `${path} ${await r.clone().text()}`).toBeLessThan(300);
  return r.json<T>();
};
const account = (h: H, o: Record<string, unknown>) => post<{ id: string }>(h, "/api/nw/accounts", o);
const holding = (h: H, o: Record<string, unknown>) => post<{ id: string; symbol: string; quantity: string }>(h, "/api/nw/holdings", o);
const balance = (h: H, accountId: string, o: Record<string, unknown>) => post<{ id: string }>(h, `/api/nw/accounts/${accountId}/balances`, o);

interface SnapRow { date: string; assets_sgd_minor: number; liabilities_sgd_minor: number; net_sgd_minor: number; breakdown_json: string; flows_sgd_minor: number; market_sgd_minor: number }
const snaps = async () => (await env.DB.prepare("SELECT * FROM networth_snapshots ORDER BY date").all<SnapRow>()).results;
const snap = async (date: string) => (await env.DB.prepare("SELECT * FROM networth_snapshots WHERE date = ?").bind(date).first<SnapRow>())!;
const quote = (symbol: string, date: string) => env.DB.prepare("SELECT * FROM price_quotes WHERE symbol = ? AND date = ?").bind(symbol, date).first<{ price_minor: number; currency: string; prev_close_minor: number | null; source: string; stale: number }>();
const bd = (r: SnapRow) => JSON.parse(r.breakdown_json) as { classes: Record<string, number>; holdings: { symbol: string; stale: boolean; quote_date: string | null; price_minor: number | null; value_sgd: number }[]; cards: { account_id: string; amount_sgd_minor: number; estimate: boolean }[] };

describe("net worth job: decimal quantity x price, FX", () => {
  it("values VOO in USD via Frankfurter and 0.12345678 BTC at a CoinGecko SGD price, end to end", async () => {
    const { h, m, calls } = setup(D1);
    m.finnhub.VOO = { c: 450.25, pc: 448.1, t: 1 };
    m.cg = { bitcoin: { sgd: 123456.78 } };
    const cash = await account(h, { name: "DBS Savings", kind: "cash" });
    await balance(h, cash.id, { amount_minor: 100000 });
    const broker = await account(h, { name: "Moomoo", kind: "brokerage", currency: "USD" });
    await holding(h, { account_id: broker.id, asset_type: "us_equity", symbol: "voo", quantity: "10" });
    const exch = await account(h, { name: "Coinbase", kind: "crypto" });
    const btc = await holding(h, { account_id: exch.id, asset_type: "crypto", symbol: "Bitcoin", quantity: "0.123456780" });
    expect(btc).toMatchObject({ symbol: "bitcoin", quantity: "0.12345678" }); // normalised, lowercase coin id

    const s = await runNetworthJob(h.e, h.deps);
    expect(s).toMatchObject({ date: "2026-10-14", fetched: 2, failed: [], stale: [], flows: 0, market: 0 });

    // quotes: integer minor units, previous close kept, source recorded
    expect(await quote("VOO", "2026-10-14")).toMatchObject({ price_minor: 45025, currency: "USD", prev_close_minor: 44810, source: "finnhub", stale: 0 });
    expect(await quote("bitcoin", "2026-10-14")).toMatchObject({ price_minor: 12345678, currency: "SGD", prev_close_minor: null, source: "coingecko", stale: 0 });

    // 10 x US$450.25 x 1.30 = S$5,853.25 ; 12345678 x 0.12345678 = 1,524,157.65 -> S$15,241.58
    const row = await snap("2026-10-14");
    expect(bd(row).classes).toEqual({ cash: 100000, stocks: 585325, crypto: 1524158, other: 0, liabilities: 0 });
    expect(row).toMatchObject({ assets_sgd_minor: 100000 + 585325 + 1524158, liabilities_sgd_minor: 0, net_sgd_minor: 2209483 });
    expect(h.fxCalls.filter((u) => u.includes("base=USD"))).toHaveLength(1);

    // CoinGecko: one batched call, demo key header, SGD
    const cg = calls("api.coingecko.com");
    expect(cg).toHaveLength(1);
    expect(cg[0]!.url).toBe("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=sgd");
    expect(cg[0]!.headers["x-cg-demo-api-key"]).toBe("ck");
    expect(calls("finnhub.io")[0]!.url).toBe("https://finnhub.io/api/v1/quote?symbol=VOO&token=fk");
  });

  it("a non-SGD cash balance is converted with the Frankfurter rate", async () => {
    const { h } = setup(D1, { rates: { JPY: 0.0089 } });
    const a = await account(h, { name: "Wise JPY", kind: "cash", currency: "JPY" });
    await balance(h, a.id, { amount_minor: 100000 }); // ¥100,000 (JPY has no minor unit) -> S$890.00
    await runNetworthJob(h.e, h.deps);
    expect(bd(await snap("2026-10-14")).classes.cash).toBe(89000);
  });
});

describe("snapshot idempotency", () => {
  it("running twice on the same day leaves one identical row", async () => {
    const { h, m } = setup(D2);
    m.finnhub.VOO = { c: 460.25, pc: 450.25 };
    const a = await account(h, { name: "Moomoo", kind: "brokerage", currency: "USD" });
    await holding(h, { account_id: a.id, asset_type: "us_equity", symbol: "VOO", quantity: "10" });
    const cash = await account(h, { name: "Cash", kind: "cash" });
    await balance(h, cash.id, { amount_minor: 100000, as_of: "2026-10-14" });
    // an earlier snapshot so that the flows/market split is non-trivial and must also be stable
    await env.DB.prepare("INSERT INTO networth_snapshots (date, assets_sgd_minor, liabilities_sgd_minor, net_sgd_minor, breakdown_json) VALUES ('2026-10-14', 1, 0, 1, ?)").bind(JSON.stringify({ accounts: [], holdings: [], cards: [], classes: { cash: 0, stocks: 0, crypto: 0, other: 0, liabilities: 0 } })).run();
    const first = await runNetworthJob(h.e, h.deps);
    const row1 = await snap("2026-10-15");
    const second = await runNetworthJob(h.e, h.deps);
    const row2 = await snap("2026-10-15");
    expect(await count("SELECT COUNT(*) AS n FROM networth_snapshots WHERE date = '2026-10-15'")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM price_quotes WHERE symbol = 'VOO'")).toBe(1);
    expect(row2).toEqual(row1);
    expect(second).toEqual(first);
  });
});

describe("flows vs market", () => {
  it("first snapshot is 0/0; a +S$500 balance edit is a flow and a price change is market", async () => {
    const { h, m } = setup(D1);
    m.finnhub.VOO = { c: 450.25, pc: 448.1 };
    const cash = await account(h, { name: "DBS Savings", kind: "cash" });
    await balance(h, cash.id, { amount_minor: 100000, as_of: "2026-10-14" });
    const a = await account(h, { name: "Moomoo", kind: "brokerage", currency: "USD" });
    await holding(h, { account_id: a.id, asset_type: "us_equity", symbol: "VOO", quantity: "10" });

    await runNetworthJob(h.e, h.deps);
    const day1 = await snap("2026-10-14");
    expect(day1).toMatchObject({ flows_sgd_minor: 0, market_sgd_minor: 0, net_sgd_minor: 100000 + 585325 });

    h.setNow(D2);
    await balance(h, cash.id, { amount_minor: 150000, as_of: "2026-10-15" }); // +S$500 saved
    m.finnhub.VOO = { c: 460.25, pc: 450.25 }; // +US$10 x 10 = US$100 = S$130
    await runNetworthJob(h.e, h.deps);
    const day2 = await snap("2026-10-15");
    expect(day2.flows_sgd_minor).toBe(50000);
    expect(day2.market_sgd_minor).toBe(13000);
    expect(day2.net_sgd_minor - day1.net_sgd_minor).toBe(63000);
    expect((await snaps()).map((s) => s.date)).toEqual(["2026-10-14", "2026-10-15"]);
  });

  it("buying more shares is a flow (the old quantity is the only market part)", async () => {
    const { h, m } = setup(D1);
    m.finnhub.VOO = { c: 450, pc: 450 };
    const a = await account(h, { name: "Moomoo", kind: "brokerage", currency: "USD" });
    const hd = await holding(h, { account_id: a.id, asset_type: "us_equity", symbol: "VOO", quantity: "10" });
    await runNetworthJob(h.e, h.deps);
    h.setNow(D2);
    m.finnhub.VOO = { c: 460, pc: 450 };
    expect((await h.call(`/api/nw/holdings/${hd.id}`, json("PATCH", { quantity: "12" }))).status).toBe(200);
    await runNetworthJob(h.e, h.deps);
    const day2 = await snap("2026-10-15");
    expect(day2.market_sgd_minor).toBe(13000); // 10 x US$10 x 1.3
    expect(day2.flows_sgd_minor).toBe(2 * 46000 * 1.3); // the two new shares at the new price
  });
});

describe("card liability from the card-cycle data", () => {
  // statement day 10: on 14 Oct the last statement is 10 Oct, the billed cycle is 11 Sep..10 Oct, the open cycle 11 Oct..
  const NOW14 = NOON14;
  async function card(h: H, o: Record<string, unknown> = {}) {
    return post<{ id: string }>(h, "/api/accounts", { name: "DBS Altitude", kind: "credit", statement_day: 10, due_day: 5, ...o });
  }
  const charge = (h: H, accountId: string, amount: number, at: string, category = "shopping") =>
    post(h, "/api/transactions", { amount_minor: amount, category_id: category, merchant: "Shop", occurred_at: `${at}T04:00:00Z`, account_id: accountId });

  it("counts the previous statement until it is marked paid (API) or covered by a card payment", async () => {
    const { h } = setup(NOW14);
    const c = await card(h);
    await charge(h, c.id, 20000, "2026-09-20"); // on the last statement
    await charge(h, c.id, 5000, "2026-10-12"); // since the statement
    const amount = async () => (await loadCardLiabilities(env.DB, NOW14)).find((x) => x.account_id === c.id)!;

    expect(await amount()).toMatchObject({ amount_sgd_minor: 25000, estimate: false, last_statement: "2026-10-10", previous_bill: 20000, previous_paid: false });
    await runNetworthJob(h.e, h.deps);
    const row = await snap("2026-10-14");
    expect(row).toMatchObject({ liabilities_sgd_minor: 25000, assets_sgd_minor: 0, net_sgd_minor: -25000 });
    expect(bd(row).cards).toEqual([{ account_id: c.id, name: "DBS Altitude", amount_sgd_minor: 25000, estimate: false, last_statement: "2026-10-10", previous_bill: 20000, previous_paid: false }]);

    // marked paid via the API -> only the open cycle remains; unmarking brings it back
    const mark = await h.call(`/api/cards/${c.id}/statement-paid`, json("POST", { statement_date: "2026-10-10" }));
    expect(mark.status).toBe(201);
    expect(await amount()).toMatchObject({ amount_sgd_minor: 5000, previous_paid: true });
    expect((await h.call(`/api/cards/${c.id}/statement-paid`, json("DELETE", { statement_date: "2026-10-10" }))).status).toBe(200);
    expect((await amount()).amount_sgd_minor).toBe(25000);

    // an earlier card payment (before the statement) does not count; one after it that covers the bill does
    await charge(h, c.id, 20000, "2026-10-05", "card_payment");
    expect((await amount()).amount_sgd_minor).toBe(25000);
    await charge(h, c.id, 20000, "2026-10-13", "card_payment");
    expect((await amount()).amount_sgd_minor).toBe(5000);

    // and the API shows the same cards
    await runNetworthJob(h.e, h.deps);
    const api = await (await h.call("/api/networth")).json<{ cards: { amount_sgd_minor: number }[]; latest: { liabilities: number; net: number } }>();
    expect(api.cards.map((x) => x.amount_sgd_minor)).toEqual([5000]);
    expect(api.latest).toMatchObject({ liabilities: 5000, net: -5000 });
  });

  it("a card without a statement day is a month-to-date estimate; mark-paid needs a real credit card", async () => {
    const { h } = setup(NOW14);
    const c = await card(h, { name: "Citi Rewards", statement_day: null, due_day: null });
    await charge(h, c.id, 3000, "2026-10-05");
    await charge(h, c.id, 9900, "2026-09-30"); // last month: not in the estimate
    expect(await loadCardLiabilities(env.DB, NOW14)).toEqual([{ account_id: c.id, name: "Citi Rewards", amount_sgd_minor: 3000, estimate: true, last_statement: null, previous_bill: 0, previous_paid: true }]);
    const debit = await post<{ id: string }>(h, "/api/accounts", { name: "POSB", kind: "debit" });
    expect((await h.call(`/api/cards/${debit.id}/statement-paid`, json("POST", { statement_date: "2026-10-10" }))).status).toBe(404);
    expect((await h.call(`/api/cards/${c.id}/statement-paid`, json("POST", { statement_date: "nope" }))).status).toBe(400);
  });
});

describe("stale prices", () => {
  async function seedYesterday(h: H, m: ReturnType<typeof market>["m"]) {
    m.finnhub.VOO = { c: 450.25, pc: 448.1 };
    const a = await account(h, { name: "Moomoo", kind: "brokerage", currency: "USD" });
    await holding(h, { account_id: a.id, asset_type: "us_equity", symbol: "VOO", quantity: "10" });
    await runNetworthJob(h.e, h.deps); // 14 Oct, 06:30
    delete m.finnhub.VOO; // Finnhub now fails (500) and Alpha Vantage has nothing (500)
  }

  it("before 12:00 SGT nothing is written for today and the snapshot uses yesterday's price marked stale", async () => {
    const { h, m } = setup(D1);
    await seedYesterday(h, m);
    h.setNow(D2); // 06:30
    const s = await runNetworthJob(h.e, h.deps);
    expect(s).toMatchObject({ date: "2026-10-15", fetched: 0, failed: ["VOO"], stale: ["VOO"] });
    expect(await quote("VOO", "2026-10-15")).toBeNull();
    const row = await snap("2026-10-15");
    expect(bd(row).holdings[0]).toMatchObject({ symbol: "VOO", stale: true, quote_date: "2026-10-14", price_minor: 45025, value_sgd: 585325 });
    expect(row.net_sgd_minor).toBe(585325);
  });

  it("the final 12:00 SGT run carries the last price forward as a stale quote", async () => {
    const { h, m } = setup(D1);
    await seedYesterday(h, m);
    h.setNow(new Date("2026-10-15T04:00:00Z")); // 12:00 SGT
    const s = await runNetworthJob(h.e, h.deps, { final: true });
    expect(s.stale).toEqual(["VOO"]);
    expect(await quote("VOO", "2026-10-15")).toMatchObject({ price_minor: 45025, prev_close_minor: 44810, stale: 1, source: "finnhub:carried" });
    expect(bd(await snap("2026-10-15")).holdings[0]).toMatchObject({ stale: true, quote_date: "2026-10-15" });
    // a real price arriving later in the day replaces it
    m.finnhub.VOO = { c: 451, pc: 450.25 };
    const again = await runNetworthJob(h.e, h.deps);
    expect(again.stale).toEqual([]);
    expect(await quote("VOO", "2026-10-15")).toMatchObject({ price_minor: 45100, stale: 0, source: "finnhub" });
  });

  it("a failed later run never overwrites a fresh quote from earlier the same day", async () => {
    const { h, m } = setup(new Date("2026-10-15T04:00:00Z"));
    m.finnhub.VOO = { c: 450.25, pc: 448.1 };
    const a = await account(h, { name: "Moomoo", kind: "brokerage", currency: "USD" });
    await holding(h, { account_id: a.id, asset_type: "us_equity", symbol: "VOO", quantity: "1" });
    await runNetworthJob(h.e, h.deps);
    delete m.finnhub.VOO;
    const s = await runNetworthJob(h.e, h.deps, { final: true });
    expect(s.stale).toEqual([]);
    expect(await quote("VOO", "2026-10-15")).toMatchObject({ price_minor: 45025, stale: 0, source: "finnhub" });
  });
});

describe("Finnhub -> Alpha Vantage fallback (mocked fetch)", () => {
  async function twoStocks(h: H, symbols: string[]) {
    const a = await account(h, { name: "Moomoo", kind: "brokerage", currency: "USD" });
    for (const s of symbols) await holding(h, { account_id: a.id, asset_type: "us_equity", symbol: s, quantity: "1" });
  }

  it("calls Alpha Vantage only for the ticker Finnhub failed on (HTTP 500, or c = 0) and records the source", async () => {
    const { h, m, calls, av } = setup(D1);
    await twoStocks(h, ["VOO", "QQQ", "SPY"]);
    m.finnhub.QQQ = { c: 400, pc: 399 };
    m.finnhub.VOO = 500;
    m.finnhub.SPY = { c: 0, pc: 0, t: 0 }; // Finnhub's answer for an unknown symbol
    m.av.VOO = av("189.37", "187.10");
    m.av.SPY = av("510.5", "509");
    const s = await runNetworthJob(h.e, h.deps);
    expect(s).toMatchObject({ fetched: 3, failed: [] });
    expect(calls("www.alphavantage.co").map((c) => new URL(c.url).searchParams.get("symbol")).sort()).toEqual(["SPY", "VOO"]);
    expect(calls("www.alphavantage.co")[0]!.url).toContain("function=GLOBAL_QUOTE");
    expect(calls("www.alphavantage.co")[0]!.url).toContain("apikey=ak");
    expect(await quote("VOO", "2026-10-14")).toMatchObject({ price_minor: 18937, prev_close_minor: 18710, source: "alphavantage", currency: "USD" });
    expect(await quote("SPY", "2026-10-14")).toMatchObject({ price_minor: 51050, source: "alphavantage" });
    expect(await quote("QQQ", "2026-10-14")).toMatchObject({ price_minor: 40000, source: "finnhub" });
  });

  it("an empty Global Quote, or a rate-limit Note / Information, counts as a failure", async () => {
    const { h, m } = setup(D1);
    await twoStocks(h, ["VOO", "QQQ", "SPY"]);
    m.av.VOO = {};
    m.av.QQQ = { Note: "Thank you for using Alpha Vantage! Our standard API call frequency is 25 requests per day." };
    m.av.SPY = { Information: "rate limit" };
    const s = await runNetworthJob(h.e, h.deps);
    expect(s.failed.sort()).toEqual(["QQQ", "SPY", "VOO"]);
    expect(await count("SELECT COUNT(*) AS n FROM price_quotes")).toBe(0);
  });

  it("without a Finnhub key Alpha Vantage is used directly; without any key nothing is fetched", async () => {
    const { h, m, calls, av } = setup(D1);
    delete h.e.FINNHUB_API_KEY;
    await twoStocks(h, ["VOO"]);
    m.av.VOO = av("189.37", "187.10");
    await runNetworthJob(h.e, h.deps);
    expect(calls("finnhub.io")).toHaveLength(0);
    expect(await quote("VOO", "2026-10-14")).toMatchObject({ source: "alphavantage", price_minor: 18937 });

    delete h.e.ALPHAVANTAGE_API_KEY;
    const before = m.calls.length;
    h.setNow(D2);
    const s = await runNetworthJob(h.e, h.deps);
    expect(m.calls.length).toBe(before);
    expect(s.failed).toEqual(["VOO"]);
  });

  it("without a CoinGecko key crypto is skipped (no request)", async () => {
    const { h, calls } = setup(D1);
    delete h.e.COINGECKO_API_KEY;
    const a = await account(h, { name: "Coinbase", kind: "crypto" });
    await holding(h, { account_id: a.id, asset_type: "crypto", symbol: "bitcoin", quantity: "1" });
    const s = await runNetworthJob(h.e, h.deps);
    expect(calls("api.coingecko.com")).toHaveLength(0);
    expect(s.failed).toEqual(["bitcoin"]);
  });
});

describe("API", () => {
  it("POST /api/networth/refresh runs the job at most once per 5 minutes", async () => {
    const { h, m } = setup(D1);
    m.finnhub.VOO = { c: 450.25, pc: 448.1 };
    const a = await account(h, { name: "Moomoo", kind: "brokerage", currency: "USD" });
    await holding(h, { account_id: a.id, asset_type: "us_equity", symbol: "VOO", quantity: "1" });
    const r1 = await h.call("/api/networth/refresh", { method: "POST" });
    expect(r1.status).toBe(200);
    expect(await r1.json()).toMatchObject({ date: "2026-10-14", fetched: 1 });
    h.setNow(new Date(D1.getTime() + 60_000));
    const r2 = await h.call("/api/networth/refresh", { method: "POST" });
    expect(r2.status).toBe(429);
    expect(await r2.json()).toMatchObject({ retry_after_s: 240 });
    expect(await count("SELECT COUNT(*) AS n FROM settings WHERE key = 'networth_last_refresh'")).toBe(1);
    h.setNow(new Date(D1.getTime() + 5 * 60_000));
    expect((await h.call("/api/networth/refresh", { method: "POST" })).status).toBe(200);
  });

  it("validates holdings, balances and accounts", async () => {
    const { h } = setup(D1);
    const a = await account(h, { name: "Moomoo", kind: "brokerage", currency: "usd", institution: "Futu" });
    expect(a).toMatchObject({ currency: "USD", include_in_networth: 1, archived: 0 });
    const hold = (o: Record<string, unknown>) => h.call("/api/nw/holdings", json("POST", { account_id: a.id, asset_type: "us_equity", symbol: "VOO", quantity: "1", ...o }));
    for (const q of ["1e-8", "abc", "-1", "", "1,5", 5]) expect((await hold({ quantity: q })).status, `quantity ${String(q)}`).toBe(400);
    expect((await hold({ asset_type: "stock" })).status).toBe(400);
    expect((await hold({ account_id: "nope" })).status).toBe(404);
    expect(await count("SELECT COUNT(*) AS n FROM holdings")).toBe(0);
    const ok = await (await hold({ quantity: "1.2500", cost_basis_minor: 40000, cost_currency: "usd", acquired_at: "2026-01-02" })).json<Record<string, unknown>>();
    expect(ok).toMatchObject({ symbol: "VOO", quantity: "1.25", cost_basis_minor: 40000, cost_currency: "USD", acquired_at: "2026-01-02" });
    expect((await h.call(`/api/nw/holdings/${ok.id}`, json("PATCH", { quantity: "0.00000001" }))).status).toBe(200);
    expect((await h.call(`/api/nw/holdings/${ok.id}`, json("PATCH", { quantity: "1e3" }))).status).toBe(400);
    expect(await (await h.call("/api/nw/holdings/" + ok.id, json("PATCH", { symbol: "vti" }))).json()).toMatchObject({ symbol: "VTI", quantity: "0.00000001" });

    // balances: currency defaults to the account's, as_of to today (SGT), flow_minor optional
    const b = await (await h.call(`/api/nw/accounts/${a.id}/balances`, json("POST", { amount_minor: 123456 }))).json<Record<string, unknown>>();
    expect(b).toMatchObject({ amount_minor: 123456, currency: "USD", as_of: "2026-10-14", flow_minor: null });
    const b2 = await (await h.call(`/api/nw/accounts/${a.id}/balances`, json("POST", { amount_minor: 5, currency: "sgd", as_of: "2026-10-01", note: "x", flow_minor: 3 }))).json<Record<string, unknown>>();
    expect(b2).toMatchObject({ currency: "SGD", as_of: "2026-10-01", flow_minor: 3, note: "x" });
    for (const bad of [{ amount_minor: 1.5 }, { amount_minor: "5" }, { amount_minor: 5, as_of: "2026-02-30" }, { amount_minor: 5, as_of: "10/01/2026" }, { amount_minor: 5, flow_minor: 0.5 }]) {
      expect((await h.call(`/api/nw/accounts/${a.id}/balances`, json("POST", bad))).status).toBe(400);
    }
    expect((await h.call("/api/nw/accounts/nope/balances", json("POST", { amount_minor: 5 }))).status).toBe(404);
    expect((await h.call(`/api/nw/balances/${b2.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await h.call(`/api/nw/balances/${b2.id}`, { method: "DELETE" })).status).toBe(404);

    // accounts
    expect((await h.call("/api/nw/accounts", json("POST", { name: "X", kind: "savings" }))).status).toBe(400);
    expect((await h.call("/api/nw/accounts", json("POST", { name: "", kind: "cash" }))).status).toBe(400);
    const patched = await (await h.call(`/api/nw/accounts/${a.id}`, json("PATCH", { archived: true, include_in_networth: 0, name: "Moomoo SG" }))).json();
    expect(patched).toMatchObject({ name: "Moomoo SG", archived: 1, include_in_networth: 0, kind: "brokerage" });
    expect((await h.call("/api/nw/accounts/nope", json("PATCH", { name: "x" }))).status).toBe(404);
    expect((await h.call(`/api/nw/holdings/${ok.id}`, { method: "DELETE" })).status).toBe(200);
  });

  it("GET /api/networth: month and YTD change split into saved vs market, plus today's move", async () => {
    const { h } = setup(NOON14);
    const empty = JSON.stringify({ accounts: [], holdings: [], cards: [], classes: { cash: 0, stocks: 0, crypto: 0, other: 0, liabilities: 0 } });
    const ins = (date: string, net: number, flows: number, market: number) =>
      env.DB.prepare("INSERT INTO networth_snapshots (date, assets_sgd_minor, liabilities_sgd_minor, net_sgd_minor, breakdown_json, flows_sgd_minor, market_sgd_minor) VALUES (?,?,0,?,?,?,?)").bind(date, net, net, empty, flows, market).run();
    await ins("2025-12-31", 1_000_000, 0, 0);
    await ins("2026-09-14", 1_500_000, 500_000, 0); // same day last month: the 1-month baseline
    await ins("2026-10-01", 1_550_000, 30_000, 20_000);
    await ins("2026-10-14", 1_620_000, 50_000, 20_000);
    const r = await (await h.call("/api/networth")).json<{
      today: string; live: boolean; latest: Record<string, unknown>; attribution: string;
      change: { month: Record<string, unknown>; ytd: Record<string, unknown>; day: Record<string, unknown> };
    }>();
    expect(r.today).toBe("2026-10-14");
    expect(r.live).toBe(false);
    expect(r.latest).toMatchObject({ date: "2026-10-14", net: 1_620_000, flows: 50_000, market: 20_000 });
    expect(r.change.month).toMatchObject({ from: "2026-09-14", to: "2026-10-14", change: 120_000, flows: 80_000, market: 40_000, partial: false });
    expect(r.change.ytd).toMatchObject({ from: "2025-12-31", change: 620_000, flows: 580_000, market: 40_000 });
    expect(r.change.day).toEqual({ date: "2026-10-14", flows: 50_000, market: 20_000, change: 70_000 });
    expect(r.attribution).toBe("Crypto prices by CoinGecko");
    const hist = await (await h.call("/api/networth/history?days=30")).json<{ date: string; net: number; classes: Record<string, number> }[]>();
    expect(hist.map((x) => x.date)).toEqual(["2026-09-14", "2026-10-01", "2026-10-14"]); // ascending, 30-day window
    expect(Object.keys(hist[0]!.classes).sort()).toEqual(["cash", "crypto", "liabilities", "other", "stocks"]);
    expect((await h.call("/api/networth/history?days=0")).status).toBe(400);
  });

  it("GET /api/networth: accounts, holdings (price, value, gain, today's move) and a live value before any snapshot", async () => {
    const { h, m } = setup(D1);
    const cash = await account(h, { name: "Old savings", kind: "cash" });
    await balance(h, cash.id, { amount_minor: 100000, as_of: "2026-08-01" }); // 74 days old
    const fresh = await account(h, { name: "Fresh", kind: "cash" });
    await balance(h, fresh.id, { amount_minor: 5000, as_of: "2026-10-10" });
    const a = await account(h, { name: "Moomoo", kind: "brokerage", currency: "USD" });
    await holding(h, { account_id: a.id, asset_type: "us_equity", symbol: "VOO", quantity: "10", cost_basis_minor: 300000, cost_currency: "SGD" });
    const get = async () => (await h.call("/api/networth")).json<{
      live: boolean; latest: { net: number; classes: Record<string, number> };
      accounts: { name: string; value_sgd: number | null; age_days: number | null; needs_update: boolean; balance: { amount_minor: number } | null }[];
      holdings: { symbol: string; price_minor: number | null; price_currency: string | null; value_sgd: number | null; gain_sgd: number | null; day_move_sgd: number | null; stale: boolean; quote_date: string | null }[];
    }>();

    const before = await get(); // no snapshot, no quotes, no FX yet: live valuation, nothing fetched
    expect(before.live).toBe(true);
    expect(before.latest.net).toBe(105000);
    expect(before.holdings[0]).toMatchObject({ symbol: "VOO", price_minor: null, stale: true });
    expect(m.calls).toHaveLength(0);

    m.finnhub.VOO = { c: 450.25, pc: 448.1 };
    await runNetworthJob(h.e, h.deps);
    const r = await get();
    expect(r.live).toBe(false);
    expect(r.accounts.find((x) => x.name === "Old savings")).toMatchObject({ age_days: 74, needs_update: true, value_sgd: 100000, balance: { amount_minor: 100000 } });
    expect(r.accounts.find((x) => x.name === "Fresh")).toMatchObject({ age_days: 4, needs_update: false });
    expect(r.accounts.find((x) => x.name === "Moomoo")).toMatchObject({ value_sgd: 585325, balance: null });
    // 10 x 45025 x 1.3 = 585325 ; cost S$3,000 -> gain 285325 ; day move 10 x (45025-44810) x 1.3 = 2795
    expect(r.holdings[0]).toMatchObject({ symbol: "VOO", price_minor: 45025, price_currency: "USD", value_sgd: 585325, gain_sgd: 285325, day_move_sgd: 2795, stale: false, quote_date: "2026-10-14" });
  });
});

describe("cron dispatch", () => {
  it("the 06:30 SGT trigger runs the job", async () => {
    const { h, m } = setup(D1);
    m.finnhub.VOO = { c: 450.25, pc: 448.1 };
    const a = await account(h, { name: "Moomoo", kind: "brokerage", currency: "USD" });
    await holding(h, { account_id: a.id, asset_type: "us_equity", symbol: "VOO", quantity: "1" });
    expect(CRON_NETWORTH).toBe("30 22 * * *");
    await runScheduled(h.e, h.deps, CRON_NETWORTH);
    expect(await count("SELECT COUNT(*) AS n FROM networth_snapshots")).toBe(1);
    expect(await quote("VOO", "2026-10-14")).toMatchObject({ stale: 0 });
  });

  it("hourly: 07:00-11:00 SGT retries only what is missing; 12:00 SGT keeps the last price as stale; otherwise nothing", async () => {
    const { h, m, calls } = setup(new Date("2026-10-14T23:00:00Z")); // 15 Oct 07:00 SGT
    const a = await account(h, { name: "Moomoo", kind: "brokerage", currency: "USD" });
    await holding(h, { account_id: a.id, asset_type: "us_equity", symbol: "VOO", quantity: "1" });
    await holding(h, { account_id: a.id, asset_type: "us_equity", symbol: "QQQ", quantity: "1" });
    await env.DB.prepare("INSERT INTO price_quotes (symbol, asset_type, date, price_minor, currency, prev_close_minor, source, stale) VALUES ('QQQ','us_equity','2026-10-14',40000,'USD',39900,'finnhub',0)").run();
    m.finnhub.VOO = { c: 450.25, pc: 448.1 }; // QQQ keeps failing
    const syms = () => calls("finnhub.io").map((c) => new URL(c.url).searchParams.get("symbol"));

    await runScheduled(h.e, h.deps, CRON_HOURLY); // 07:00: snapshot missing -> run (both symbols: nothing fresh yet)
    expect(syms().sort()).toEqual(["QQQ", "VOO"]);
    expect(await quote("VOO", "2026-10-15")).toMatchObject({ stale: 0 });
    expect(await quote("QQQ", "2026-10-15")).toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM networth_snapshots WHERE date = '2026-10-15'")).toBe(1);

    h.setNow(new Date("2026-10-15T00:00:00Z")); // 08:00: QQQ still lacks a fresh quote -> retry only QQQ
    await runScheduled(h.e, h.deps, CRON_HOURLY);
    expect(syms().slice(2)).toEqual(["QQQ"]);
    expect(await quote("QQQ", "2026-10-15")).toBeNull();

    h.setNow(new Date("2026-10-15T03:00:00Z")); // 11:00: still retrying, not final
    await runScheduled(h.e, h.deps, CRON_HOURLY);
    expect(syms().slice(3)).toEqual(["QQQ"]);
    expect(await quote("QQQ", "2026-10-15")).toBeNull();

    h.setNow(new Date("2026-10-15T04:00:00Z")); // 12:00: final run -> yesterday's QQQ price carried forward, stale
    await runScheduled(h.e, h.deps, CRON_HOURLY);
    expect(syms().slice(4)).toEqual(["QQQ"]);
    expect(await quote("QQQ", "2026-10-15")).toMatchObject({ price_minor: 40000, stale: 1, source: "finnhub:carried" });

    const n = m.calls.length;
    h.setNow(new Date("2026-10-15T05:00:00Z")); // 13:00: past the window, no more retries
    await runScheduled(h.e, h.deps, CRON_HOURLY);
    h.setNow(new Date("2026-10-14T21:00:00Z")); // 05:00 SGT: before the window
    await runScheduled(h.e, h.deps, CRON_HOURLY);
    expect(m.calls.length).toBe(n);
  });

  it("hourly: nothing to retry once today's snapshot and every quote are fresh", async () => {
    const { h, m, calls } = setup(new Date("2026-10-14T23:00:00Z"));
    const a = await account(h, { name: "Moomoo", kind: "brokerage", currency: "USD" });
    await holding(h, { account_id: a.id, asset_type: "us_equity", symbol: "VOO", quantity: "1" });
    m.finnhub.VOO = { c: 450.25, pc: 448.1 };
    await runScheduled(h.e, h.deps, CRON_HOURLY);
    expect(calls("finnhub.io")).toHaveLength(1);
    h.setNow(new Date("2026-10-15T04:00:00Z")); // 12:00 SGT, everything fresh -> no final run
    await runScheduled(h.e, h.deps, CRON_HOURLY);
    expect(calls("finnhub.io")).toHaveLength(1);
  });
});

describe("monthly summary", () => {
  const FIRST = new Date("2026-10-01T01:00:00Z"); // 1 Oct 09:00 SGT
  const empty = JSON.stringify({ accounts: [], holdings: [], cards: [], classes: { cash: 0, stocks: 0, crypto: 0, other: 0, liabilities: 0 } });
  const ins = (date: string, net: number, flows: number, market: number) =>
    env.DB.prepare("INSERT INTO networth_snapshots (date, assets_sgd_minor, liabilities_sgd_minor, net_sgd_minor, breakdown_json, flows_sgd_minor, market_sgd_minor) VALUES (?,?,0,?,?,?,?)").bind(date, net, net, empty, flows, market).run();
  const outbox = async () => (await env.DB.prepare("SELECT kind, tag, payload_json FROM push_outbox WHERE kind = 'monthly_summary'").all<{ kind: string; tag: string; payload_json: string }>()).results.map((r) => ({ ...r, payload: JSON.parse(r.payload_json) as { title: string; body: string; url: string; tag: string } }));

  async function september() {
    await ins("2026-08-31", 1_000_000, 0, 0);
    await ins("2026-09-15", 1_060_000, 40_000, 20_000);
    await ins("2026-09-30", 1_124_000, 50_000, 14_000);
    await ins("2026-10-01", 1_130_000, 6_000, 0); // today: not part of September
  }

  it("says how much of the month's change was saved vs market, once per month, via the nudge gate", async () => {
    const { h } = setup(FIRST);
    await september();
    const r = await sendMonthlySummary(h.e, h.deps);
    expect(r).toEqual({ sent: true, body: "September: net worth +S$1,240 (you saved +S$900 · market +S$340)." });
    const rows = await outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ body: r.body, tag: "monthly-summary", url: "/money/networth" });
    expect(await sendMonthlySummary(h.e, h.deps)).toEqual({ sent: false });
    expect(await outbox()).toHaveLength(1);
    expect(await count("SELECT COUNT(*) AS n FROM alert_log WHERE kind = 'monthly_summary' AND ref = 'all' AND period = '2026-09'")).toBe(1);
  });

  it("shows negative market moves with a minus sign and adds one stale-balance reminder", async () => {
    const { h } = setup(new Date("2026-11-01T01:00:00Z"));
    await ins("2026-09-30", 1_000_000, 0, 0);
    await ins("2026-10-31", 1_010_000, 30_000, -20_000);
    const a = await account(h, { name: "Old", kind: "cash" });
    await balance(h, a.id, { amount_minor: 100, as_of: "2026-09-01" }); // 61 days old
    const b = await account(h, { name: "Older", kind: "manual_asset" });
    await balance(h, b.id, { amount_minor: 100, as_of: "2026-08-01" });
    const c = await account(h, { name: "Fresh", kind: "cash" });
    await balance(h, c.id, { amount_minor: 100, as_of: "2026-10-30" });
    const r = await sendMonthlySummary(h.e, h.deps);
    expect(r.body).toBe("October: net worth +S$100 (you saved +S$300 · market -S$200). · 2 balances need updating");
  });

  it("skips the net worth part without snapshots (and sends nothing at all when there is nothing to say)", async () => {
    const { h } = setup(FIRST);
    expect(await sendMonthlySummary(h.e, h.deps)).toEqual({ sent: false });
    expect(await count("SELECT COUNT(*) AS n FROM alert_log WHERE kind = 'monthly_summary'")).toBe(0);
    const a = await account(h, { name: "Old", kind: "cash" });
    await balance(h, a.id, { amount_minor: 100, as_of: "2026-07-01" });
    expect(await sendMonthlySummary(h.e, h.deps)).toEqual({ sent: true, body: "September: 1 balance needs updating" });
  });

  it("is sent by the hourly cron on the 1st at 09:00 SGT only", async () => {
    const { h } = setup(new Date("2026-10-01T00:00:00Z")); // 08:00 SGT
    await september();
    await runScheduled(h.e, h.deps, CRON_HOURLY);
    expect(await outbox()).toHaveLength(0);
    h.setNow(FIRST);
    await runScheduled(h.e, h.deps, CRON_HOURLY);
    expect(await outbox()).toHaveLength(1);
    h.setNow(new Date("2026-10-01T02:00:00Z")); // 10:00
    await runScheduled(h.e, h.deps, CRON_HOURLY);
    h.setNow(new Date("2026-10-02T01:00:00Z")); // 2 Oct 09:00
    await runScheduled(h.e, h.deps, CRON_HOURLY);
    expect(await outbox()).toHaveLength(1);
  });
});
