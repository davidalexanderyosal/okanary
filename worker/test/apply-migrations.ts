import { applyD1Migrations, env } from "cloudflare:test";

// Applies migrations/*.sql to the isolated test D1 before each test file.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
