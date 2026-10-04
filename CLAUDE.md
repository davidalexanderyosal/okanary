# Okanary: notes for Claude Code

Single-user personal spend tracker PWA (David, Singapore). Read before changing anything:
`okanary-spec.md` (v1 spec), `docs/feature-brief-v2.md` (v2 features A U N G W S P), `docs/plan-v2.md` (how v2 maps onto
this code), `PROGRESS.md` (status, "Needs David"), `DECISIONS.md` (every judgement call, D-xx).

## Layout
```
packages/core   pure TS maths, no I/O (money, SGT dates, THE spend definition, pace, allowance, baselines, goals, plan…)  Vitest
worker          Hono API + cron + email handler on a Cloudflare Worker, D1 migrations in worker/migrations           Vitest (workerd pool)
web             React + Vite + Tailwind PWA, Recharts                                                                Vitest
```

## Commands
```
npm test                    # all workspaces (core, worker, web) – must exit 0
npm run build               # web build, then worker tsc + wrangler dry-run – must exit 0
npm run db:migrate:local    # apply worker/migrations to the local D1 (.wrangler/state)
npm test -w @okanary/core   # one workspace (also -w @okanary/worker, -w @okanary/web)
```
Never run `deploy`, `db:migrate:remote` or anything touching remote Cloudflare.

## Rules
- Money: integer ISO 4217 minor units (`packages/core/src/money.ts`). Never floats. FX via `convertMinor`.
- Quantities (holdings): decimal strings, maths via `packages/core/src/decimal.ts` (BigInt). Never floats.
- Time: store UTC ISO strings; every day/week/month boundary is Asia/Singapore (`dates.ts`, fixed UTC+8).
- Every spend total goes through `isSpend`/`sumSpend` (`spend.ts`) – one spend definition.
- Deterministic maths lives in `packages/core` as pure, unit-tested functions; the worker only loads rows and calls them.
- Migrations: add a new numbered file in `worker/migrations`; never edit an applied one. Tests apply all migrations.
- Pushes: post-purchase pushes go straight out; every other push goes through the nudge gate (`worker/src/nudge-gate.ts`:
  daily limit + quiet hours). Once-per-period alerts use `alert_log` + `INSERT OR IGNORE` (unique index).
- External APIs (Finnhub, Alpha Vantage, CoinGecko, Frankfurter): always via `deps.fetch`; tests mock it. No real calls.
- Email fixtures are synthetic and named `worker/fixtures/synthetic-*.txt`; parsers built on them are marked UNVERIFIED.
- User-facing tone: neutral/encouraging, never shaming; amber (not red) for "above usual". Projection/plan screens show
  assumptions + "Estimates, not financial advice."
- UI: reuse `web/src/components` (Sheet, Toast, Icons, PaceBar, TxnRow) and the Konbini Clay tokens in `web/src/index.css`.
- Log any departure from the spec/brief in `DECISIONS.md`; keep `PROGRESS.md` current.
