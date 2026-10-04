import {
  billEstimate, buildSnapshot, cardLiabilityAmount, carryForwardStale, cycleBounds, latestBalance, monthRangeUtc, quoteForDay,
  shouldRetryPrices, sgtDate, sgtMonth, sgtParts, splitFlowsMarket,
  type AssetType, type CardLiability, type FxLookup, type Holding, type NwAccount, type NwBalance, type PriceQuote, type SnapshotValues, type SummaryRow,
} from "@okanary/core";
import { TXN_WITH_GROUP_SQL } from "./db";
import type { Deps } from "./deps";
import type { Env } from "./env";
import { getSgdRate } from "./fx";
import { snapshotGoals } from "./goals";
import { fetchPrices, priceKey, type WantedSymbol } from "./prices";
import { setSetting } from "./settings";

/**
 * Daily net worth job (v2 N): fetch prices -> price_quotes, value everything in SGD -> one networth_snapshots row per SGT day.
 * Safe to run any number of times a day (INSERT OR REPLACE keyed on the date; the flows/market split always compares with
 * the latest EARLIER snapshot, so a re-run gives the same row).
 */

export interface NetworthJobSummary { date: string; net: number; flows: number; market: number; fetched: number; failed: string[]; stale: string[] }

/** Distinct (symbol, asset_type) held in non-archived accounts. */
export async function heldSymbols(db: D1Database): Promise<WantedSymbol[]> {
  return (await db.prepare(
    `SELECT DISTINCT h.symbol AS symbol, h.asset_type AS asset_type FROM holdings h JOIN nw_accounts a ON a.id = h.account_id
     WHERE a.archived = 0 ORDER BY h.asset_type, h.symbol`,
  ).all<WantedSymbol>()).results;
}

/** Held symbols with no fresh (non-stale) quote for `date`. */
export async function symbolsMissingFreshQuote(db: D1Database, date: string): Promise<WantedSymbol[]> {
  const held = await heldSymbols(db);
  const fresh = new Set((await db.prepare("SELECT symbol, asset_type FROM price_quotes WHERE date = ? AND stale = 0").bind(date).all<WantedSymbol>()).results.map(priceKey));
  return held.filter((w) => !fresh.has(priceKey(w)));
}

export async function hasSnapshot(db: D1Database, date: string): Promise<boolean> {
  return !!(await db.prepare("SELECT 1 AS x FROM networth_snapshots WHERE date = ?").bind(date).first());
}

/**
 * Card liabilities from the card-cycle data (the same cycles as /api/cycles) for every non-archived credit account:
 * the open cycle's bill, plus the last statement's bill until it is marked paid or card payments cover it.
 * Cards without a statement day: charges since the 1st of this SGT month, flagged as an estimate.
 */
export interface CardLiabilityDetail extends CardLiability {
  /** configured cards: the last statement date, its bill and whether it counts as paid (for "Mark statement paid") */
  last_statement: string | null;
  previous_bill: number;
  previous_paid: boolean;
}

export async function loadCardLiabilities(db: D1Database, now: Date): Promise<CardLiabilityDetail[]> {
  const today = sgtDate(now);
  const accts = (await db.prepare("SELECT id, name, statement_day, due_day FROM accounts WHERE archived = 0 AND kind = 'credit' ORDER BY name").all<{ id: string; name: string; statement_day: number | null; due_day: number | null }>()).results;
  const out: CardLiabilityDetail[] = [];
  for (const a of accts) {
    let input: Parameters<typeof cardLiabilityAmount>[0];
    let lastStatement: string | null = null;
    if (a.statement_day) {
      const b = cycleBounds(a.statement_day, a.due_day, today);
      lastStatement = b.lastStatement;
      const rows = (await db.prepare(`${TXN_WITH_GROUP_SQL} WHERE t.account_id = ? AND t.occurred_at >= ? AND t.occurred_at < ?`).bind(a.id, b.previous.start, b.current.end).all<SummaryRow>()).results;
      const inRange = (r: SummaryRow, x: { start: string; end: string }) => r.occurred_at >= x.start && r.occurred_at < x.end;
      const paid = await db.prepare("SELECT 1 AS x FROM card_statement_paid WHERE account_id = ? AND statement_date = ?").bind(a.id, b.lastStatement).first();
      const pay = await db.prepare("SELECT COALESCE(SUM(amount_sgd_minor), 0) AS n FROM transactions WHERE account_id = ? AND category_id = 'card_payment' AND status != 'void' AND occurred_at >= ?").bind(a.id, b.current.start).first<{ n: number }>();
      input = {
        configured: true, current_bill: billEstimate(rows.filter((r) => inRange(r, b.current))), previous_bill: billEstimate(rows.filter((r) => inRange(r, b.previous))),
        marked_paid: !!paid, payments_since_statement: pay?.n ?? 0,
      };
    } else {
      const rows = (await db.prepare(`${TXN_WITH_GROUP_SQL} WHERE t.account_id = ? AND t.occurred_at >= ?`).bind(a.id, monthRangeUtc(sgtMonth(now)).start).all<SummaryRow>()).results;
      input = { configured: false, current_bill: 0, previous_bill: 0, month_to_date_bill: billEstimate(rows) };
    }
    const r = cardLiabilityAmount(input);
    out.push({ account_id: a.id, name: a.name, amount_sgd_minor: r.amount, estimate: r.estimate, last_statement: lastStatement, previous_bill: input.previous_bill, previous_paid: r.previous_paid });
  }
  return out;
}

export interface SnapshotInputs { accounts: NwAccount[]; balances: NwBalance[]; holdings: Holding[]; quotes: PriceQuote[] }

/** Everything buildSnapshot needs from D1 as of `date` (non-archived accounts only; quotes for held symbols up to `date`). */
export async function loadSnapshotInputs(db: D1Database, date: string): Promise<SnapshotInputs> {
  const accounts = (await db.prepare("SELECT * FROM nw_accounts WHERE archived = 0 ORDER BY name, id").all<NwAccount>()).results;
  const balances = (await db.prepare("SELECT b.* FROM nw_balances b JOIN nw_accounts a ON a.id = b.account_id WHERE a.archived = 0 AND b.as_of <= ?").bind(date).all<NwBalance>()).results;
  const holdings = (await db.prepare("SELECT h.* FROM holdings h JOIN nw_accounts a ON a.id = h.account_id WHERE a.archived = 0").all<Holding>()).results;
  const held = new Set(holdings.map((h) => `${h.asset_type}:${h.symbol}`));
  const quotes = (await db.prepare("SELECT * FROM price_quotes WHERE date <= ?").bind(date).all<PriceQuote>()).results.filter((q) => held.has(`${q.asset_type}:${q.symbol}`));
  return { accounts, balances, holdings, quotes };
}

/** Non-SGD currencies the valuation needs: account/balance currencies, quote currencies and cost currencies. */
export function neededCurrencies(i: SnapshotInputs, date: string): string[] {
  const cur = new Set<string>();
  for (const a of i.accounts) {
    cur.add(a.currency);
    const b = latestBalance(i.balances, a.id, date);
    if (b) cur.add(b.currency);
  }
  for (const h of i.holdings) {
    const q = quoteForDay(i.quotes, h.symbol, h.asset_type as AssetType, date);
    if (q) cur.add(q.quote.currency);
    if (h.cost_currency) cur.add(h.cost_currency);
  }
  return [...cur].map((c) => c.toUpperCase()).filter((c) => c !== "SGD");
}

export const fxFromMap = (rates: Map<string, number>): FxLookup => (c) => (c.toUpperCase() === "SGD" ? 1 : rates.get(c.toUpperCase()) ?? null);

/** Rates already in the fx_rates cache (latest per currency); never fetches. */
export async function cachedFx(db: D1Database, currencies: string[]): Promise<FxLookup> {
  const rates = new Map<string, number>();
  for (const c of currencies) {
    const r = await db.prepare("SELECT rate FROM fx_rates WHERE base = ? AND quote = 'SGD' ORDER BY date DESC LIMIT 1").bind(c.toUpperCase()).first<{ rate: number }>();
    if (r) rates.set(c.toUpperCase(), r.rate);
  }
  return fxFromMap(rates);
}

interface SnapshotRow { date: string; assets_sgd_minor: number; liabilities_sgd_minor: number; net_sgd_minor: number; breakdown_json: string; flows_sgd_minor: number; market_sgd_minor: number }

export const snapshotFromRow = (r: SnapshotRow): SnapshotValues => ({ date: r.date, assets: r.assets_sgd_minor, liabilities: r.liabilities_sgd_minor, net: r.net_sgd_minor, breakdown: JSON.parse(r.breakdown_json) });

export async function previousSnapshot(db: D1Database, before: string): Promise<SnapshotValues | null> {
  const r = await db.prepare("SELECT * FROM networth_snapshots WHERE date < ? ORDER BY date DESC LIMIT 1").bind(before).first<SnapshotRow>();
  return r ? snapshotFromRow(r) : null;
}

/** Hook for feature G: writes goal_snapshots and refreshes goal horizons (and the one-time safer-funding prompt) from the day's snapshot. */
export async function afterSnapshot(env: Env, deps: Deps, snapshot: SnapshotValues): Promise<void> {
  await snapshotGoals(env, deps, snapshot);
}

export interface NetworthJobOptions {
  /** Keep the last known price (marked stale) for tickers that could not be fetched. Default: true from 12:00 SGT onwards. */
  final?: boolean;
  /** Hourly retry: only fetch symbols that still have no fresh quote for today (saves the 25-calls/day Alpha Vantage budget). */
  retry?: boolean;
}

export async function runNetworthJob(env: Env, deps: Deps, opts: NetworthJobOptions = {}): Promise<NetworthJobSummary> {
  const now = deps.now();
  const today = sgtDate(now);
  const final = opts.final ?? !shouldRetryPrices(sgtParts(now).hour);

  // 1. prices
  const wanted = opts.retry ? await symbolsMissingFreshQuote(env.DB, today) : await heldSymbols(env.DB);
  const results = await fetchPrices(env, deps, wanted);
  let fetched = 0;
  const failed: string[] = [];
  for (const w of wanted) {
    const p = results.get(priceKey(w)) ?? null;
    if (p) {
      await env.DB.prepare("INSERT OR REPLACE INTO price_quotes (symbol, asset_type, date, price_minor, currency, prev_close_minor, source, stale) VALUES (?,?,?,?,?,?,?,0)")
        .bind(w.symbol, w.asset_type, today, p.price_minor, p.currency, p.prev_close_minor, p.source).run();
      fetched++;
      continue;
    }
    failed.push(w.symbol);
    if (!final) continue; // the hourly retry will try again
    const fresh = await env.DB.prepare("SELECT 1 AS x FROM price_quotes WHERE symbol = ? AND asset_type = ? AND date = ? AND stale = 0").bind(w.symbol, w.asset_type, today).first();
    if (fresh) continue; // an earlier run today already has a real price
    const last = await env.DB.prepare("SELECT * FROM price_quotes WHERE symbol = ? AND asset_type = ? AND date < ? ORDER BY date DESC LIMIT 1").bind(w.symbol, w.asset_type, today).first<PriceQuote>();
    if (!last) continue;
    const c = carryForwardStale(last, today);
    await env.DB.prepare("INSERT OR REPLACE INTO price_quotes (symbol, asset_type, date, price_minor, currency, prev_close_minor, source, stale) VALUES (?,?,?,?,?,?,?,1)")
      .bind(c.symbol, c.asset_type, c.date, c.price_minor, c.currency, c.prev_close_minor ?? null, c.source ?? null).run();
  }

  // 2. FX for every non-SGD currency the valuation needs
  const inputs = await loadSnapshotInputs(env.DB, today);
  const rates = new Map<string, number>();
  for (const cur of neededCurrencies(inputs, today)) {
    const r = await getSgdRate(env.DB, cur, now, deps.fetch);
    if (r) rates.set(cur, r.rate);
  }

  // 3. card liabilities, snapshot, flows vs market
  const cards = await loadCardLiabilities(env.DB, now);
  const cur = buildSnapshot({ date: today, ...inputs, cards, fx: fxFromMap(rates) });
  const prev = await previousSnapshot(env.DB, today);
  const { flows, market } = splitFlowsMarket(prev, cur);
  await env.DB.prepare("INSERT OR REPLACE INTO networth_snapshots (date, assets_sgd_minor, liabilities_sgd_minor, net_sgd_minor, breakdown_json, flows_sgd_minor, market_sgd_minor) VALUES (?,?,?,?,?,?,?)")
    .bind(today, cur.assets, cur.liabilities, cur.net, JSON.stringify(cur.breakdown), flows, market).run();
  await setSetting(env.DB, "networth_last_run", now.toISOString());
  await afterSnapshot(env, deps, cur);

  const stale = [...new Set(cur.breakdown.holdings.filter((h) => h.stale).map((h) => h.symbol))];
  return { date: today, net: cur.net, flows, market, fetched, failed, stale };
}
