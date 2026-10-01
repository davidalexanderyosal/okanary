import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(fileURLToPath(new URL("./migrations", import.meta.url)));
  // Email fixtures (worker/fixtures/*.txt) are read here, on the Node side, and handed to tests as a binding.
  const dir = fileURLToPath(new URL("./fixtures", import.meta.url));
  const fixtures = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith(".txt")).map((f) => [f.replace(/\.txt$/, ""), readFileSync(`${dir}/${f}`, "utf8")]));
  return {
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          singleWorker: true,
          wrangler: { configPath: "./wrangler.test.jsonc" },
          miniflare: { bindings: { TEST_MIGRATIONS: migrations, FIXTURES: fixtures } },
        },
      },
    },
  };
});
