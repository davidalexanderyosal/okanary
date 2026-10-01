# Okanary

Single-user personal spend tracker (PWA). See `okanary-spec.md` for the full spec, `PROGRESS.md` for build status
and `DECISIONS.md` for every judgement call.

```
packages/core   money (integer minor units), SGT dates, THE spend definition, month summary  (Vitest)
worker          Hono API on a Cloudflare Worker + D1 migrations                               (Vitest, workerd)
web             React + Vite + Tailwind PWA (vite-plugin-pwa, Recharts)                       (Vitest)
wrangler.jsonc  one Worker serving /api/* and the built PWA (Workers Static Assets)
```

## Local development (no Cloudflare account needed)

```bash
npm install
npm test                       # all workspaces
npm run build                  # web, then worker (wrangler dry-run)
npm run db:migrate:local       # applies worker/migrations to the local D1 (.wrangler/state)
npm run dev                    # builds web, serves everything on http://localhost:8787
# or: npx wrangler dev   +   npm run dev -w web   (Vite on :5173 proxies /api to :8787)
```

Never run `db:migrate:remote` or `deploy` unless you mean to; see the end-of-build summary / PROGRESS.md for the exact first-deploy steps.

## Rules the code follows
- Money is an integer count of ISO 4217 minor units. Never floats (`packages/core/src/money.ts`).
- Timestamps are UTC ISO strings; every day/month boundary is computed in Asia/Singapore (`dates.ts`).
- Every total goes through the spend definition in `packages/core/src/spend.ts`.
- Cloudflare Access protects the app; there is no login code.
