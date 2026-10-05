import { apiPriceToMinor } from "@okanary/core";
import type { Deps } from "./deps";
import type { Env } from "./env";

/**
 * Price sources for net worth (v2 N). Every request goes through deps.fetch with an 8 s timeout; every error is caught and
 * turned into "no price" (the job then retries hourly, and finally keeps the last price marked stale). API numbers are
 * converted with apiPriceToMinor (exact decimal parsing, never Number * 100). URLs carry API keys, so they are never logged.
 */
export type AssetKind = "us_equity" | "crypto";
export interface WantedSymbol { symbol: string; asset_type: AssetKind }
export interface PriceResult { price_minor: number; currency: string; prev_close_minor: number | null; source: string }
/** Key in the result map: `${asset_type}:${symbol}`. A symbol that could not be priced maps to null. */
export const priceKey = (s: WantedSymbol) => `${s.asset_type}:${s.symbol}`;

const TIMEOUT_MS = 8000;
const timeout = () => AbortSignal.timeout(TIMEOUT_MS);

/** Finnhub /quote → {c: current, pc: previous close}. c <= 0 or missing is a failure (unknown symbols return zeros). */
export async function finnhubQuote(deps: Deps, symbol: string, key: string): Promise<PriceResult | null> {
  try {
    const res = await deps.fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(key)}`, { signal: timeout() });
    if (!res.ok) return null;
    const j = (await res.json()) as { c?: unknown; pc?: unknown };
    if (typeof j.c !== "number" || !(j.c > 0)) return null;
    const price = apiPriceToMinor(j.c, "USD");
    if (price == null || price <= 0) return null;
    const prev = typeof j.pc === "number" && j.pc > 0 ? apiPriceToMinor(j.pc, "USD") : null;
    return { price_minor: price, currency: "USD", prev_close_minor: prev, source: "finnhub" };
  } catch {
    return null;
  }
}

/** Alpha Vantage GLOBAL_QUOTE. An empty "Global Quote" or a "Note" / "Information" body (rate limit) is a failure. */
export async function alphaVantageQuote(deps: Deps, symbol: string, key: string): Promise<PriceResult | null> {
  try {
    const res = await deps.fetch(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(key)}`, { signal: timeout() });
    if (!res.ok) return null;
    const j = (await res.json()) as Record<string, unknown>;
    if (j["Note"] || j["Information"]) return null;
    const q = j["Global Quote"] as Record<string, unknown> | undefined;
    const raw = q?.["05. price"];
    if (typeof raw !== "string" && typeof raw !== "number") return null;
    const price = apiPriceToMinor(raw, "USD");
    if (price == null || price <= 0) return null;
    const pc = q?.["08. previous close"];
    const prev = typeof pc === "string" || typeof pc === "number" ? apiPriceToMinor(pc, "USD") : null;
    return { price_minor: price, currency: "USD", prev_close_minor: prev != null && prev > 0 ? prev : null, source: "alphavantage" };
  } catch {
    return null;
  }
}

/** One batched CoinGecko call for all coin ids; prices are in SGD, previous close is unknown (null). */
export async function coingeckoPrices(deps: Deps, ids: string[], key: string): Promise<Map<string, PriceResult>> {
  const out = new Map<string, PriceResult>();
  if (ids.length === 0) return out;
  try {
    const res = await deps.fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.map(encodeURIComponent).join(",")}&vs_currencies=sgd`, { headers: { "x-cg-demo-api-key": key }, signal: timeout() });
    if (!res.ok) return out;
    const j = (await res.json()) as Record<string, { sgd?: unknown } | undefined>;
    for (const id of ids) {
      const v = j[id]?.sgd;
      if (typeof v !== "number" && typeof v !== "string") continue;
      const price = apiPriceToMinor(v, "SGD");
      if (price != null && price > 0) out.set(id, { price_minor: price, currency: "SGD", prev_close_minor: null, source: "coingecko" });
    }
  } catch {
    /* no prices this round */
  }
  return out;
}

/** Fetch every wanted symbol. Stocks: Finnhub, then Alpha Vantage for that ticker only if Finnhub failed. Crypto: CoinGecko. */
export async function fetchPrices(env: Env, deps: Deps, wanted: WantedSymbol[]): Promise<Map<string, PriceResult | null>> {
  const out = new Map<string, PriceResult | null>();
  for (const w of wanted) {
    if (w.asset_type !== "us_equity") continue;
    let r: PriceResult | null = null;
    if (env.FINNHUB_API_KEY) r = await finnhubQuote(deps, w.symbol, env.FINNHUB_API_KEY);
    if (!r && env.ALPHAVANTAGE_API_KEY) r = await alphaVantageQuote(deps, w.symbol, env.ALPHAVANTAGE_API_KEY);
    out.set(priceKey(w), r);
  }
  const coins = wanted.filter((w) => w.asset_type === "crypto");
  const got = env.COINGECKO_API_KEY ? await coingeckoPrices(deps, coins.map((w) => w.symbol), env.COINGECKO_API_KEY) : new Map<string, PriceResult>();
  for (const w of coins) out.set(priceKey(w), got.get(w.symbol) ?? null);
  return out;
}
