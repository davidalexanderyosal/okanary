import { convertMinor } from "./money";
import { mulDecimalByMinor } from "./decimal";

/**
 * Net worth (v2 feature N). Pure valuation + the daily "you saved vs market" split. Integer minor units; quantities are
 * decimal strings (decimal.ts); FX rates are "1 unit of X = rate SGD" (fx_rates table) and go through convertMinor.
 *
 * Split (D-54): market = price/FX movement on what was already held the previous snapshot day; flows = Δnet − market.
 * So the two always add up to the change in net worth, and anything David did himself (balance edits, buys/sells,
 * new holdings, card spending, loan changes) lands in flows.
 */

export type NwKind = "cash" | "brokerage" | "crypto" | "manual_asset" | "liability";
export type AssetType = "us_equity" | "crypto";
export type AssetClass = "cash" | "stocks" | "crypto" | "other";

export interface NwAccount { id: string; name: string; kind: NwKind; currency: string; include_in_networth: number; archived: number }
export interface NwBalance { id: string; account_id: string; amount_minor: number; currency: string; as_of: string; flow_minor?: number | null }
export interface Holding { id: string; account_id: string; asset_type: AssetType; symbol: string; quantity: string; cost_basis_minor?: number | null; cost_currency?: string | null }
export interface PriceQuote { symbol: string; asset_type: AssetType; date: string; price_minor: number; currency: string; prev_close_minor?: number | null; source?: string; stale?: number }
export interface CardLiability { account_id: string; name: string; amount_sgd_minor: number; estimate: boolean }
/** SGD per 1 unit of `currency` (1 for SGD), or null when unknown. */
export type FxLookup = (currency: string) => number | null;

export const toSgd = (minor: number, currency: string, fx: FxLookup): number | null => {
  if (currency.toUpperCase() === "SGD") return minor;
  const r = fx(currency);
  return r == null ? null : convertMinor(minor, currency, "SGD", r);
};

/** Value of a quantity at a price (price_minor per unit, in the quote's currency) → minor units of that currency. */
export const holdingValue = (quantity: string, priceMinor: number): number => mulDecimalByMinor(quantity, priceMinor);

/** Latest balance on or before `date` (as_of is 'YYYY-MM-DD'); ties → the later id (ULIDs sort by time). */
export function latestBalance(balances: NwBalance[], accountId: string, date: string): NwBalance | null {
  let best: NwBalance | null = null;
  for (const b of balances) {
    if (b.account_id !== accountId || b.as_of > date) continue;
    if (!best || b.as_of > best.as_of || (b.as_of === best.as_of && b.id > best.id)) best = b;
  }
  return best;
}

/** The quote to use on `date`: that day's, else the most recent earlier one (then stale). */
export function quoteForDay(quotes: PriceQuote[], symbol: string, assetType: AssetType, date: string): { quote: PriceQuote; stale: boolean } | null {
  let best: PriceQuote | null = null;
  for (const q of quotes) {
    if (q.symbol !== symbol || q.asset_type !== assetType || q.date > date) continue;
    if (!best || q.date > best.date) best = q;
  }
  return best ? { quote: best, stale: best.date !== date || !!best.stale } : null;
}

/** Price fetching retries hourly until 12:00 SGT; after that the last price is carried forward, marked stale. */
export const PRICE_RETRY_UNTIL_SGT_HOUR = 12;
export const shouldRetryPrices = (sgtHour: number) => sgtHour < PRICE_RETRY_UNTIL_SGT_HOUR;
export const carryForwardStale = (last: PriceQuote, date: string): PriceQuote => ({ ...last, date, stale: 1, source: last.source ? `${last.source}:carried` : "carried" });

/**
 * Card liability from the card-cycle data: spent since the last statement plus the last statement's bill until it is
 * paid. A statement counts as paid when marked so, when its bill is ≤ 0, or when card payments after the statement date
 * cover it. Cards without a statement day: charges since the 1st of the month, flagged as an estimate (D-55).
 */
export function cardLiabilityAmount(c: { configured: boolean; current_bill: number; previous_bill: number; marked_paid?: boolean; payments_since_statement?: number; month_to_date_bill?: number }): { amount: number; previous_paid: boolean; estimate: boolean } {
  if (!c.configured) return { amount: c.month_to_date_bill ?? 0, previous_paid: true, estimate: true };
  const paid = !!c.marked_paid || c.previous_bill <= 0 || (c.payments_since_statement ?? 0) >= c.previous_bill;
  return { amount: c.current_bill + (paid ? 0 : c.previous_bill), previous_paid: paid, estimate: false };
}

export interface BreakdownAccount {
  id: string; name: string; kind: NwKind; currency: string;
  /** manual balance (account currency) and its SGD value; liabilities are positive amounts owed */
  balance_minor: number; balance_sgd: number; fx: number | null;
  balance_id: string | null; balance_as_of: string | null; flow_minor: number | null;
  /** SGD value of holdings in this account */
  holdings_sgd: number;
  missing_fx: boolean;
}
export interface BreakdownHolding {
  id: string; account_id: string; symbol: string; asset_type: AssetType; quantity: string;
  price_minor: number | null; price_currency: string | null; fx: number | null; value_sgd: number;
  prev_close_minor: number | null; quote_date: string | null; stale: boolean;
}
export interface Breakdown {
  accounts: BreakdownAccount[];
  holdings: BreakdownHolding[];
  cards: CardLiability[];
  classes: { cash: number; stocks: number; crypto: number; other: number; liabilities: number };
}
export interface SnapshotValues { date: string; assets: number; liabilities: number; net: number; breakdown: Breakdown }

export interface SnapshotInput {
  date: string; // SGT 'YYYY-MM-DD'
  accounts: NwAccount[];
  balances: NwBalance[];
  holdings: Holding[];
  quotes: PriceQuote[];
  cards: CardLiability[];
  fx: FxLookup;
}

/** Value everything as of `date`. Unknown FX → that item counts 0 and is flagged (never a guessed rate). */
export function buildSnapshot(i: SnapshotInput): SnapshotValues {
  const classes = { cash: 0, stocks: 0, crypto: 0, other: 0, liabilities: 0 };
  const accounts: BreakdownAccount[] = [];
  const holdings: BreakdownHolding[] = [];
  for (const a of i.accounts) {
    if (a.archived || !a.include_in_networth) continue;
    const bal = latestBalance(i.balances, a.id, i.date);
    const cur = bal?.currency ?? a.currency;
    const amt = bal?.amount_minor ?? 0;
    const sgd = toSgd(amt, cur, i.fx);
    const fx = cur.toUpperCase() === "SGD" ? 1 : i.fx(cur);
    let holdingsSgd = 0;
    for (const h of i.holdings.filter((x) => x.account_id === a.id)) {
      const q = quoteForDay(i.quotes, h.symbol, h.asset_type, i.date);
      const pfx = q ? (q.quote.currency.toUpperCase() === "SGD" ? 1 : i.fx(q.quote.currency)) : null;
      const value = q && pfx != null ? toSgd(holdingValue(h.quantity, q.quote.price_minor), q.quote.currency, i.fx) ?? 0 : 0;
      holdings.push({
        id: h.id, account_id: a.id, symbol: h.symbol, asset_type: h.asset_type, quantity: h.quantity,
        price_minor: q?.quote.price_minor ?? null, price_currency: q?.quote.currency ?? null, fx: pfx, value_sgd: value,
        prev_close_minor: q?.quote.prev_close_minor ?? null, quote_date: q?.quote.date ?? null, stale: !q || q.stale || pfx == null,
      });
      holdingsSgd += value;
      if (h.asset_type === "crypto") classes.crypto += value;
      else classes.stocks += value;
    }
    const balSgd = sgd ?? 0;
    if (a.kind === "liability") classes.liabilities += balSgd;
    else if (a.kind === "manual_asset") classes.other += balSgd;
    else classes.cash += balSgd; // cash accounts and cash held at brokers / exchanges
    accounts.push({
      id: a.id, name: a.name, kind: a.kind, currency: cur, balance_minor: amt, balance_sgd: balSgd, fx,
      balance_id: bal?.id ?? null, balance_as_of: bal?.as_of ?? null, flow_minor: bal?.flow_minor ?? null, holdings_sgd: holdingsSgd,
      missing_fx: sgd == null,
    });
  }
  for (const c of i.cards) classes.liabilities += c.amount_sgd_minor;
  const assets = classes.cash + classes.stocks + classes.crypto + classes.other;
  return { date: i.date, assets, liabilities: classes.liabilities, net: assets - classes.liabilities, breakdown: { accounts, holdings, cards: i.cards, classes } };
}

/**
 * Market movement between two snapshots (prev = the latest earlier snapshot):
 *  - holdings present in both: prev quantity revalued at today's price and FX, minus its previous SGD value;
 *  - non-SGD balances unchanged since prev: FX movement on the previous balance (negative for liabilities);
 *  - a manual-asset balance update carrying flow_minor: the part of the change beyond flow_minor (C7).
 * flows = Δnet − market. Without a previous snapshot both are 0.
 */
export function splitFlowsMarket(prev: SnapshotValues | null, cur: SnapshotValues): { flows: number; market: number } {
  if (!prev) return { flows: 0, market: 0 };
  let market = 0;
  for (const v of marketByItem(prev, cur).values()) market += v;
  return { flows: cur.net - prev.net - market, market };
}

/**
 * Market movement per item between two snapshots: keys 'holding:<id>' and 'account:<id>' (an account's own balance only;
 * its holdings are separate keys). Liabilities move with a negative sign. Used by splitFlowsMarket and by goal pace (G),
 * which must not count market gains on a goal's linked assets as contributions.
 */
export function marketByItem(prev: SnapshotValues, cur: SnapshotValues): Map<string, number> {
  const out = new Map<string, number>();
  const prevH = new Map(prev.breakdown.holdings.map((h) => [h.id, h]));
  for (const h of cur.breakdown.holdings) {
    const p = prevH.get(h.id);
    if (!p || h.price_minor == null || h.fx == null || p.price_minor == null) continue;
    const prevQtyNow = convertMinor(holdingValue(p.quantity, h.price_minor), h.price_currency ?? "SGD", "SGD", h.fx);
    out.set(`holding:${h.id}`, prevQtyNow - p.value_sgd);
  }
  const prevA = new Map(prev.breakdown.accounts.map((a) => [a.id, a]));
  for (const a of cur.breakdown.accounts) {
    const p = prevA.get(a.id);
    if (!p || a.missing_fx || p.missing_fx) continue;
    const sign = a.kind === "liability" ? -1 : 1;
    let m = 0;
    if (a.currency.toUpperCase() !== "SGD" && p.currency === a.currency && a.fx != null) {
      // FX on the balance that was already there
      m += sign * (convertMinor(p.balance_minor, a.currency, "SGD", a.fx) - p.balance_sgd);
    }
    if (a.kind === "manual_asset" && a.balance_id !== p.balance_id && a.flow_minor != null && a.fx != null && p.currency === a.currency) {
      m += convertMinor(a.balance_minor - p.balance_minor - a.flow_minor, a.currency, "SGD", a.fx);
    }
    if (m !== 0) out.set(`account:${a.id}`, m);
  }
  return out;
}

export interface NwSnapshotRow { date: string; net_sgd_minor: number; flows_sgd_minor: number; market_sgd_minor: number }

/**
 * Change from the last snapshot on/before `fromDate` (the baseline) to the last snapshot on/before `toDate`, with the
 * flows/market of every snapshot in between. No snapshot before `fromDate` → the first one is the baseline (partial).
 */
export function changeOverRange(rows: NwSnapshotRow[], fromDate: string, toDate: string): { from: string; to: string; change: number; flows: number; market: number; partial: boolean } | null {
  const sorted = [...rows].filter((r) => r.date <= toDate).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (sorted.length === 0) return null;
  let baseIdx = -1;
  for (let k = 0; k < sorted.length; k++) if (sorted[k]!.date <= fromDate) baseIdx = k;
  const partial = baseIdx === -1;
  if (partial) baseIdx = 0;
  const base = sorted[baseIdx]!;
  const end = sorted[sorted.length - 1]!;
  let flows = 0, market = 0;
  for (let k = baseIdx + 1; k < sorted.length; k++) { flows += sorted[k]!.flows_sgd_minor; market += sorted[k]!.market_sgd_minor; }
  return { from: base.date, to: end.date, change: end.net_sgd_minor - base.net_sgd_minor, flows, market, partial };
}

/** Gain vs cost basis (both converted to SGD), or null without a cost basis or FX. */
export function holdingGainSgd(h: Pick<Holding, "cost_basis_minor" | "cost_currency">, valueSgd: number, fx: FxLookup): number | null {
  if (h.cost_basis_minor == null) return null;
  const cost = toSgd(h.cost_basis_minor, h.cost_currency ?? "SGD", fx);
  return cost == null ? null : valueSgd - cost;
}

/** Today's move of a holding vs the previous close (SGD), shown on the net worth screen only (never pushed). */
export function holdingDayMoveSgd(h: Pick<BreakdownHolding, "quantity" | "price_minor" | "prev_close_minor" | "price_currency" | "fx">): number | null {
  if (h.price_minor == null || h.prev_close_minor == null || h.fx == null) return null;
  const diff = holdingValue(h.quantity, h.price_minor) - holdingValue(h.quantity, h.prev_close_minor);
  return convertMinor(diff, h.price_currency ?? "SGD", "SGD", h.fx);
}

/** Balances older than this many days get a quiet "update?" chip. */
export const BALANCE_STALE_DAYS = 30;
export function balanceAgeDays(asOf: string | null, today: string): number | null {
  if (!asOf) return null;
  return Math.round((Date.parse(today) - Date.parse(asOf)) / 86400_000);
}
