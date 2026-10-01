export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Bearer token for /api/ingest/* (Phase 2+). Set with `wrangler secret put INGEST_TOKEN`. */
  INGEST_TOKEN?: string;
}
export type AppEnv = { Bindings: Env };
