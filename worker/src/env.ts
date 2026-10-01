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
}
export type AppEnv = { Bindings: Env; Variables: { deps: Deps } };
