import type { Deps } from "./deps";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Workers AI (categorisation suggestions, email-parse fallback). Optional: everything degrades without it. */
  AI?: { run(model: string, input: unknown): Promise<unknown> };
  /** Bootstrap bearer token for /api/ingest/*. A token rotated from Settings (stored in D1) takes precedence. */
  INGEST_TOKEN?: string;
  /** Web Push (VAPID). Generate with `npm run vapid`. */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  /** Verified Email Routing destination (your Gmail): non-alert mail (e.g. Gmail's forwarding verification) is forwarded here. */
  FORWARD_TO?: string;
  /** Extra sender domains, e.g. "mail.dbs.com:dbs,example.com:citi". */
  ALERT_SENDER_DOMAINS?: string;
  /** Net worth prices (v2 N). Worker secrets (`wrangler secret put ...`); a missing key just skips that source. */
  /** Finnhub /quote: primary source for US stock / ETF prices. */
  FINNHUB_API_KEY?: string;
  /** Alpha Vantage GLOBAL_QUOTE: fallback used only for tickers Finnhub fails on (25 calls/day on the free tier). */
  ALPHAVANTAGE_API_KEY?: string;
  /** CoinGecko Demo key (x-cg-demo-api-key header) for crypto prices in SGD. Attribution is shown on the net worth screen. */
  COINGECKO_API_KEY?: string;
}
export type AppEnv = { Bindings: Env; Variables: { deps: Deps } };
