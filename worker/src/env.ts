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
}
export type AppEnv = { Bindings: Env; Variables: { deps: Deps } };
