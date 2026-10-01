import type { applyD1Migrations } from "cloudflare:test";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    INGEST_TOKEN?: string;
    FIXTURES: Record<string, string>;
    FORWARD_TO?: string;
    TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
  }
}
