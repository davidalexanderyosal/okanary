import { describe, expect, it } from "vitest";
import { addDecimal, apiPriceToMinor, applyBp, cmpDecimal, isDecimal, mulDecimalByMinor, normalizeDecimal, subDecimal } from "./decimal";
import {
  balanceAgeDays, buildSnapshot, cardLiabilityAmount, carryForwardStale, changeOverRange, holdingDayMoveSgd, holdingGainSgd, quoteForDay,
  marketByItem, shouldRetryPrices, splitFlowsMarket, toSgd, type FxLookup, type Holding, type NwAccount, type NwBalance, type PriceQuote,
} from "./networth";

const fx = (rates: Record<string, number>): FxLookup => (c) => (c === "SGD" ? 1 : rates[c] ?? null);

describe("N: decimal quantity × price", () => {
  it("parses, normalises and adds decimal strings without floats", () => {
    expect(normalizeDecimal("0.10000000")).toBe("0.1");
    expect(normalizeDecimal(".5")).toBe("0.5");
    expect(normalizeDecimal("-0.000")).toBe("0");
    expect(addDecimal("0.1", "0.2")).toBe("0.3"); // 0.30000000000000004 with floats
    expect(subDecimal("1", "0.00000001")).toBe("0.99999999");
    expect(cmpDecimal("0.123456789", "0.12345679")).toBe(-1);
    expect(isDecimal("1e-8")).toBe(false);
    expect(isDecimal("12.5")).toBe(true);
  });
  it("multiplies 8+ dp quantities by an integer minor price, half away from zero", () => {
    expect(mulDecimalByMinor("0.12345678", 9_000_000)).toBe(1111111); // 0.12345678 BTC × US$90,000.00 = US$11,111.1102
    expect(mulDecimalByMinor("10", 23456)).toBe(234560);
    expect(mulDecimalByMinor("0.5", 3)).toBe(2); // 1.5 → 2
    expect(mulDecimalByMinor("-0.5", 3)).toBe(-2);
    expect(mulDecimalByMinor("0.000000015", 100)).toBe(0);
    expect(applyBp(100000, 2500)).toBe(25000);
    expect(applyBp(333, 5000)).toBe(167);
  });
  it("turns API prices into minor units", () => {
    expect(apiPriceToMinor(189.37, "USD")).toBe(18937);
    expect(apiPriceToMinor("189.375", "USD")).toBe(18938);
    expect(apiPriceToMinor(123456.789, "SGD")).toBe(12345679);
    expect(apiPriceToMinor(1e-7, "SGD")).toBe(0);
    expect(apiPriceToMinor("abc", "USD")).toBeNull();
    expect(apiPriceToMinor(-1, "USD")).toBeNull();
  });
});

describe("N: FX conversion and valuation", () => {
  const accounts: NwAccount[] = [
    { id: "dbs", name: "DBS savings", kind: "cash", currency: "SGD", include_in_networth: 1, archived: 0 },
    { id: "usd", name: "USD wallet", kind: "cash", currency: "USD", include_in_networth: 1, archived: 0 },
    { id: "ibkr", name: "IBKR", kind: "brokerage", currency: "USD", include_in_networth: 1, archived: 0 },
    { id: "cold", name: "Cold wallet", kind: "crypto", currency: "SGD", include_in_networth: 1, archived: 0 },
    { id: "robo", name: "Robo", kind: "manual_asset", currency: "SGD", include_in_networth: 1, archived: 0 },
    { id: "loan", name: "Loan", kind: "liability", currency: "SGD", include_in_networth: 1, archived: 0 },
    { id: "old", name: "Closed", kind: "cash", currency: "SGD", include_in_networth: 1, archived: 1 },
  ];
  const balances: NwBalance[] = [
    { id: "b1", account_id: "dbs", amount_minor: 1_000_000, currency: "SGD", as_of: "2026-09-01" },
    { id: "b2", account_id: "dbs", amount_minor: 1_200_000, currency: "SGD", as_of: "2026-10-01" },
    { id: "b3", account_id: "usd", amount_minor: 100_000, currency: "USD", as_of: "2026-10-01" },
    { id: "b4", account_id: "robo", amount_minor: 500_000, currency: "SGD", as_of: "2026-10-01" },
    { id: "b5", account_id: "loan", amount_minor: 300_000, currency: "SGD", as_of: "2026-10-01" },
    { id: "b6", account_id: "old", amount_minor: 999_999, currency: "SGD", as_of: "2026-10-01" },
  ];
  const holdings: Holding[] = [
    { id: "h1", account_id: "ibkr", asset_type: "us_equity", symbol: "VOO", quantity: "10", cost_basis_minor: 400000, cost_currency: "USD" },
    { id: "h2", account_id: "cold", asset_type: "crypto", symbol: "bitcoin", quantity: "0.5" },
  ];
  const quotes: PriceQuote[] = [
    { symbol: "VOO", asset_type: "us_equity", date: "2026-10-13", price_minor: 50000, currency: "USD", prev_close_minor: 49000 },
    { symbol: "bitcoin", asset_type: "crypto", date: "2026-10-13", price_minor: 12_000_000, currency: "SGD" },
  ];
  const r = fx({ USD: 1.3 });

  it("converts USD to SGD exactly via convertMinor; unknown FX gives null, never a guess", () => {
    expect(toSgd(100_000, "USD", r)).toBe(130_000);
    expect(toSgd(100_000, "JPY", r)).toBeNull();
    expect(toSgd(5, "SGD", r)).toBe(5);
  });

  it("values cash, stocks (USD→SGD), crypto, other and liabilities", () => {
    const s = buildSnapshot({ date: "2026-10-13", accounts, balances, holdings, quotes, cards: [{ account_id: "c1", name: "DBS card", amount_sgd_minor: 45_000, estimate: false }], fx: r });
    expect(s.breakdown.classes).toEqual({ cash: 1_200_000 + 130_000, stocks: 650_000, crypto: 6_000_000, other: 500_000, liabilities: 300_000 + 45_000 });
    expect(s.assets).toBe(8_480_000);
    expect(s.net).toBe(8_480_000 - 345_000);
    expect(s.breakdown.accounts.map((a) => a.id)).not.toContain("old");
    const voo = s.breakdown.holdings.find((h) => h.id === "h1")!;
    expect(holdingGainSgd(holdings[0]!, voo.value_sgd, r)).toBe(650_000 - 520_000);
    expect(holdingDayMoveSgd(voo)).toBe(13_000); // 10 × US$10 × 1.3
  });

  it("uses the balance in force on the date (history), and flags missing FX", () => {
    const s = buildSnapshot({ date: "2026-09-15", accounts: accounts.slice(0, 2), balances, holdings: [], quotes: [], cards: [], fx: fx({}) });
    expect(s.breakdown.accounts.find((a) => a.id === "dbs")!.balance_sgd).toBe(1_000_000);
    expect(s.breakdown.accounts.find((a) => a.id === "usd")!.balance_sgd).toBe(0); // no balance yet on 15 Sep
    const t = buildSnapshot({ date: "2026-10-13", accounts: accounts.slice(0, 2), balances, holdings: [], quotes: [], cards: [], fx: fx({}) });
    expect(t.breakdown.accounts.find((a) => a.id === "usd")!.missing_fx).toBe(true);
  });
});

describe("N: stale prices", () => {
  const q: PriceQuote[] = [
    { symbol: "VOO", asset_type: "us_equity", date: "2026-10-12", price_minor: 49000, currency: "USD" },
    { symbol: "VOO", asset_type: "us_equity", date: "2026-10-13", price_minor: 50000, currency: "USD", stale: 1 },
  ];
  it("today's quote is fresh; an older one is stale; a carried-forward one is stale", () => {
    expect(quoteForDay(q, "VOO", "us_equity", "2026-10-12")).toMatchObject({ stale: false, quote: { price_minor: 49000 } });
    expect(quoteForDay(q.slice(0, 1), "VOO", "us_equity", "2026-10-14")).toMatchObject({ stale: true, quote: { date: "2026-10-12" } });
    expect(quoteForDay(q, "VOO", "us_equity", "2026-10-13")!.stale).toBe(true);
    expect(quoteForDay(q, "VOO", "crypto", "2026-10-13")).toBeNull();
    expect(carryForwardStale(q[0]!, "2026-10-14")).toMatchObject({ date: "2026-10-14", stale: 1, price_minor: 49000 });
  });
  it("retries until 12:00 SGT, then keeps the last price", () => {
    expect(shouldRetryPrices(7)).toBe(true);
    expect(shouldRetryPrices(11)).toBe(true);
    expect(shouldRetryPrices(12)).toBe(false);
  });
  it("a holding without any quote is valued 0 and flagged stale", () => {
    const s = buildSnapshot({ date: "2026-10-13", accounts: [{ id: "x", name: "x", kind: "brokerage", currency: "USD", include_in_networth: 1, archived: 0 }], balances: [], holdings: [{ id: "h", account_id: "x", asset_type: "us_equity", symbol: "NEW", quantity: "1" }], quotes: [], cards: [], fx: fx({ USD: 1.3 }) });
    expect(s.breakdown.holdings[0]).toMatchObject({ value_sgd: 0, stale: true });
  });
});

describe("N: flows vs market (worked example)", () => {
  const acc: NwAccount[] = [
    { id: "dbs", name: "DBS", kind: "cash", currency: "SGD", include_in_networth: 1, archived: 0 },
    { id: "ibkr", name: "IBKR", kind: "brokerage", currency: "USD", include_in_networth: 1, archived: 0 },
  ];
  const h: Holding[] = [{ id: "h1", account_id: "ibkr", asset_type: "us_equity", symbol: "VOO", quantity: "10" }];
  const bal: NwBalance[] = [{ id: "b1", account_id: "dbs", amount_minor: 1_000_000, currency: "SGD", as_of: "2026-10-01" }];
  const q1: PriceQuote = { symbol: "VOO", asset_type: "us_equity", date: "2026-10-12", price_minor: 50000, currency: "USD" };
  const day1 = buildSnapshot({ date: "2026-10-12", accounts: acc, balances: bal, holdings: h, quotes: [q1], cards: [], fx: fx({ USD: 1.3 }) });

  it("a balance edit counts as flow; a price change counts as market", () => {
    const q2: PriceQuote = { ...q1, date: "2026-10-13", price_minor: 52000 };
    const day2 = buildSnapshot({ date: "2026-10-13", accounts: acc, balances: [...bal, { id: "b2", account_id: "dbs", amount_minor: 1_050_000, currency: "SGD", as_of: "2026-10-13" }], holdings: h, quotes: [q1, q2], cards: [], fx: fx({ USD: 1.3 }) });
    expect(day2.net - day1.net).toBe(50_000 + 26_000);
    expect(splitFlowsMarket(day1, day2)).toEqual({ flows: 50_000, market: 26_000 }); // S$500 saved, 10 × US$20 × 1.3 market
  });
  it("buying more units is flow; FX movement on held USD is market", () => {
    const more: Holding[] = [{ ...h[0]!, quantity: "12" }];
    const q2: PriceQuote = { ...q1, date: "2026-10-13" };
    const day2 = buildSnapshot({ date: "2026-10-13", accounts: acc, balances: bal, holdings: more, quotes: [q1, q2], cards: [], fx: fx({ USD: 1.35 }) });
    const { flows, market } = splitFlowsMarket(day1, day2);
    expect(market).toBe(675_000 - 650_000); // 10 units revalued at the new FX
    expect(flows).toBe(810_000 - 675_000); // 2 new units at today's value
    expect(flows + market).toBe(day2.net - day1.net);
    expect([...marketByItem(day1, day2)]).toEqual([["holding:h1", 25_000]]);
  });
  it("card spending is flow; a manual asset update can declare its deposit (rest is market)", () => {
    const robo: NwAccount = { id: "robo", name: "Robo", kind: "manual_asset", currency: "SGD", include_in_networth: 1, archived: 0 };
    const b0: NwBalance = { id: "r1", account_id: "robo", amount_minor: 100_000, currency: "SGD", as_of: "2026-10-01" };
    const a = buildSnapshot({ date: "2026-10-12", accounts: [robo], balances: [b0], holdings: [], quotes: [], cards: [], fx: fx({}) });
    const b = buildSnapshot({ date: "2026-10-13", accounts: [robo], balances: [b0, { id: "r2", account_id: "robo", amount_minor: 130_000, currency: "SGD", as_of: "2026-10-13", flow_minor: 20_000 }], holdings: [], quotes: [], cards: [{ account_id: "c", name: "card", amount_sgd_minor: 5_000, estimate: false }], fx: fx({}) });
    expect(splitFlowsMarket(a, b)).toEqual({ market: 10_000, flows: 20_000 - 5_000 });
    const c = buildSnapshot({ date: "2026-10-13", accounts: [robo], balances: [b0, { id: "r2", account_id: "robo", amount_minor: 130_000, currency: "SGD", as_of: "2026-10-13" }], holdings: [], quotes: [], cards: [], fx: fx({}) });
    expect(splitFlowsMarket(a, c)).toEqual({ market: 0, flows: 30_000 }); // no declared deposit: a balance edit is flow
  });
  it("first snapshot has no split; ranges sum daily flows/market", () => {
    expect(splitFlowsMarket(null, day1)).toEqual({ flows: 0, market: 0 });
    const rows = [
      { date: "2026-09-10", net_sgd_minor: 1000, flows_sgd_minor: 0, market_sgd_minor: 0 },
      { date: "2026-09-14", net_sgd_minor: 1300, flows_sgd_minor: 200, market_sgd_minor: 100 },
      { date: "2026-10-01", net_sgd_minor: 1250, flows_sgd_minor: -100, market_sgd_minor: 50 },
      { date: "2026-10-14", net_sgd_minor: 1500, flows_sgd_minor: 300, market_sgd_minor: -50 },
    ];
    expect(changeOverRange(rows, "2026-09-14", "2026-10-14")).toEqual({ from: "2026-09-14", to: "2026-10-14", change: 200, flows: 200, market: 0, partial: false });
    expect(changeOverRange(rows, "2026-01-01", "2026-10-14")).toMatchObject({ from: "2026-09-10", change: 500, flows: 400, market: 100, partial: true });
    expect(changeOverRange([], "2026-01-01", "2026-10-14")).toBeNull();
  });
});

describe("N: card liability from card-cycle data", () => {
  it("since-statement spend plus the statement until paid", () => {
    expect(cardLiabilityAmount({ configured: true, current_bill: 40_000, previous_bill: 120_000 })).toEqual({ amount: 160_000, previous_paid: false, estimate: false });
    expect(cardLiabilityAmount({ configured: true, current_bill: 40_000, previous_bill: 120_000, marked_paid: true }).amount).toBe(40_000);
    expect(cardLiabilityAmount({ configured: true, current_bill: 40_000, previous_bill: 120_000, payments_since_statement: 120_000 }).amount).toBe(40_000);
    expect(cardLiabilityAmount({ configured: true, current_bill: 40_000, previous_bill: 120_000, payments_since_statement: 50_000 }).amount).toBe(160_000);
    expect(cardLiabilityAmount({ configured: false, current_bill: 0, previous_bill: 0, month_to_date_bill: 33_000 })).toEqual({ amount: 33_000, previous_paid: true, estimate: true });
  });
  it("balance age for the 'update?' chip", () => {
    expect(balanceAgeDays("2026-09-01", "2026-10-14")).toBe(43);
    expect(balanceAgeDays(null, "2026-10-14")).toBeNull();
  });
});
