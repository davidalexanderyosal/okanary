# Progress

Branch: `claude/okanary-phases-0-5`. All work is local only (nothing deployed, no remote Cloudflare calls).

## Phase 0 — Skeleton: DONE
- Monorepo (npm workspaces): `packages/core`, `worker`, `web`; single `wrangler.jsonc` (Worker + static assets + D1 binding).
- Migration `0001_init.sql`: full spec §6 schema + seeded groups/categories.
- Hono `/api/health`; installable PWA shell (manifest, service worker, icons, iOS meta tags, safe-area CSS).
- Verified: `npm test`, `npm run build`, migrations apply to local D1, `wrangler dev` serves API + SPA + manifest.

## Phase 1 — Manual logging + basic dashboard: DONE
- API: accounts, categories/groups, transactions (create/list/search/filter/edit/delete), month summary.
- Web: Home (month total, delta vs same day last month, Lifestyle card, group bars, latest 5), Quick add (3 taps), Activity list + edit sheet, Reports (donut + category bars), Settings (accounts, categories, install hint).
- Verified: see transcript; headless-Chromium run at iPhone viewport (390×844) saved S$12.50 to Food & Drinks with +, amount, chip.

## Phase 2 — Apple Pay auto-capture + Review inbox + rules: DONE
- `POST /api/ingest/applepay` (bearer token, zod-validated, constant-time compare, rate limit, retry de-dupe): parses `S$12.50`, `Rp 45.000`, `¥1,200`, `$8.90`; maps Wallet card name → account; normalises merchant; FX for foreign currency (Frankfurter, cached in `fx_rates`); saves as `pending`; raw payload always stored (`raw_ingest`).
- Categorisation: merchant rule → history → Workers AI suggestion (optional) → uncategorised. "Always use X for MERCHANT?" prompt creates rules; rules list in Settings.
- Review inbox page (`/review`): one-tap chips, AI suggestion confirm, exclude (button + swipe), failed-parse cards with raw text, Home "N to categorise" badge.
- Web push (VAPID, own implementation on `@block65/webcrypto-web-push`): post-purchase nudge "S$14.50 · Ya Kun · Coffee — Lifestyle S$642 (day 14/31)", custom service worker, tap opens the item. Setup page (`/setup`): URL, token (show/copy/rotate), step-by-step Shortcut instructions, push enable/test/toggle.
- Verified: worker integration tests (27) cover auth, capture, dedupe, rules/history/AI order, FX, push (VAPID header, 410 prune, toggle); `wrangler dev` + curl showed 401 without token, pending txn with normalised merchant, review + summary counting it.
- Not verifiable here: a real push delivery to an iPhone, a real Shortcut run, live Frankfurter FX (sandbox blocks it; the no-rate path D-13 was exercised instead), live Workers AI (remote-only; a fake was injected).

## Phase 3 — Email capture (DBS, Citi) + dedup: DONE, parsers UNVERIFIED
- Email Worker (`email()` export): sender allow-list + DKIM-aligned check, forward-through for everything else (incl. Gmail's forwarding verification), `postal-mime` parsing (text or HTML), Message-ID idempotency, raw always stored in `raw_ingest`.
- Parsers `worker/src/parsers/{dbs,citi}.ts` + Workers AI fallback (`needs_review`) + failed-parse cards. **UNVERIFIED: no real bank emails were available; tests use invented `worker/fixtures/synthetic-*.txt`.** Citi may not send per-transaction email at all (spec §2).
- Dedup/merge Apple Pay ↔ email (core `dedup.ts`, 30 min / 1% / same card / merchant similarity), auto-merge or "Possible duplicate — merge?" review card (migration 0002); raw capture log page (`/raw`); email status on Setup page.
- Hourly cron: pending → confirmed after 24 h; "no DBS email in 3 days" alert.
- Verified: 63 worker tests (parsers per fixture, handler routing/trust, merge in both arrival orders, no double counting, cron), 84 core tests; `wrangler dev` local email endpoint: Apple Pay tap S$14.49 + DBS email S$14.50 → ONE confirmed transaction (S$14.50, Apple Pay time), forged email ignored, month total not double counted.
- Bug found by tests and fixed: D1 `LIKE` pattern >50 bytes (D-27).

## Phase 4 — Budgets, pace and alerts: DONE
- Budgets screen (per spend group and per category, copy last month, progress bars with pace marker); `budgets` API with `effective_from` inheritance.
- Home: Lifestyle `spent / budget`, pace bar + marker, "Ahead of / On / Under pace", "Safe to spend today: S$x" (core `pace.ts`).
- Threshold pushes at 50/80/100% (configurable) via `alert_log` (migration 0003 unique index → once per budget/month/threshold, race-free); post-purchase push now shows `Lifestyle S$x / S$budget (day d/n)`.
- Card-cycle view per card (since last statement, next statement, due date, last statement total; bill estimate vs spend); full Reports: Overview donut + category bars, Daily bars + cumulative vs pace line, Top merchants, 6-month Lifestyle trend, Cards.
- Multi-currency: currency picker in Quick add (keypad follows the currency's decimals, live SGD estimate, trip currency suggestion), automatic ECB conversion + `fx_rates` cache + hourly FX refresh, trips (CRUD in Settings, auto-tagging by date).
- Verified: core 97 tests (pace/safe-to-spend/thresholds/cycle dates/bill), worker 84 tests (budgets, alerts incl. once-per-period + race + spend-definition + jump-over-thresholds, FX, trips, cycles, trend); `wrangler dev` demo: Lifestyle crossing 50% then 80% of a S$900 budget wrote exactly one `alert_log` row each and nothing on further small spends.
- Not verifiable here: real push delivery, live Frankfurter rates (sandbox blocks them), iPhone rendering of charts.

## Phase 5 — Insight and accuracy: DONE
- Subscriptions: daily detection (≥3 monthly charges, similar amount), Subscriptions screen with monthly/yearly totals, confirm / "Not one" / scan now.
- Trends: per-group and per-category 6-month chart, month-over-month table (total, groups, categories with ▲▼ %).
- Weekly digest push (Sunday 20:00 SGT): week total, Lifestyle vs pace, biggest 3 purchases; toggle in Setup.
- Statement import & reconcile (CSV or pasted PDF text): preview, then apply; corrects billed SGD, adds missing, ignores payments, idempotent.
- Trips with exclude-from-monthly (hidden from totals/budgets/alerts, still in trip total and card bill), trip totals, trip filter in Activity; CSV export of all transactions.
- Verified: core 124 tests, worker 100 tests (detection/dismissal/cron, digest content + once-per-week, CSV, import preview/commit/idempotency/trip tagging/FX-guess correction, trip exclusion vs bill); `wrangler dev` with `--test-scheduled`: daily cron detected Netflix, weekly cron wrote the digest `alert_log` row, trip excluded from the month total, import commit then re-import added nothing, CSV served with BOM + download headers.
- Bugs found and fixed by tests/demo during Phase 5: statement text parser read "12 SEP 13 SEP" as year 2013; import didn't trip-tag; SGD-typed guesses of foreign purchases were duplicated instead of corrected.

## Status summary (end of build)
All of Phases 0–5 are implemented, tested locally and committed on `claude/okanary-phases-0-5`. Nothing was deployed and no remote Cloudflare resource was touched.
Totals at the end: 124 core + 100 worker + 10 web unit/integration tests passing; web and worker builds exit 0.

## Needs you (cumulative)
- Decide your monthly budgets in the app (spec §10.7: last month's actual minus 10–15% is a good first Lifestyle value).
- Set each credit card's statement day and due day (Settings → Accounts) to light up the card-cycle view.
- **Real emails (spec §10.1):** save 3–5 redacted DBS alert emails (incl. one foreign-currency) and any Citi ones into `worker/fixtures/` as `dbs-*.txt`/`citi-*.txt`; the parsers must be checked/adjusted against them. Until then treat DBS/Citi parsing as unproven (the AI fallback and Review inbox are the safety net).
- **First real forwarded email:** confirm Cloudflare reports `dkim=pass header.d=dbs.com` in Authentication-Results (else every alert is forwarded as "untrusted"); adjust `email-auth.ts` if not.
- DBS digibank: lower the alert threshold and enable email delivery; check Citi Mobile alert preferences (spec §10.2–3).
- Cloudflare: enable Email Routing on a domain/subdomain, route `spend@<domain>` to this Worker, verify your Gmail as a destination, set `FORWARD_TO` to it; then create the Gmail forwarding filter (spec §10.5).
- iPhone test of Home-Screen install + Quick add feel (safe areas, keyboard).
- Secrets for Phase 2: `INGEST_TOKEN` (or generate in the app's Setup page), VAPID keys via `npm run vapid` → `wrangler secret put VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/VAPID_SUBJECT`.
- Cloudflare Access: add a Bypass policy for path `/api/ingest/applepay` so the Shortcut can reach it (token-protected). Optional WAF rate-limit rule on that path.
- iPhone: build the Shortcuts Wallet automation using the in-app Setup page; Wallet card names must match Settings → account → Apple Wallet card name.
- **Deploy, Access, Email Routing, iPhone install: follow README "First deploy"** (exact commands there).
- Cloudflare: create D1, put real `database_id` in `wrangler.jsonc`, deploy, set up Access (commands will be in the final summary).

## Known limitations / things I could not verify offline
- DBS and Citi email parsers are UNVERIFIED (invented fixtures only); DKIM trust check unverified against real forwarded mail.
- Real push delivery to an iPhone, a real Shortcuts Wallet run, live Frankfurter/ECB rates and live Workers AI could not be exercised in this sandbox (fakes/injection used; code paths for outages are tested).
- PDF statements must be pasted as text (no in-app PDF parsing).
- No Playwright/iPhone end-to-end suite; the UI was checked with headless Chromium at 390×844 only.
- A foreign purchase recorded in SGD and billed >6% away still imports as a new line (shows up in the preview before you apply).

---

# v2 (docs/feature-brief-v2.md): A → U → N → G → W → S → P

Branch: `claude/cool-goldberg-e9ec40`. Plan: `docs/plan-v2.md`. Nothing deployed.

| Feature | Status |
|---|---|
| Plan (step 1) | DONE |
| A — Weekly Lifestyle allowance | DONE |
| U — "Vs your usual" | DONE |
| N — Net worth | DONE |
| G — Goals | todo |
| W — Want list | todo |
| S — Subscriptions hub | todo |
| P — Income & plan | todo |

## A — Weekly Lifestyle allowance: DONE
- Core: `allowance.ts` (proration per month with exact month sums D-47, override, carry chain D-48, week safe-to-spend), configurable weeks in `dates.ts` (`sgtWeek`, `isoWeekLabel`), `nudge-gate.ts` (limit + quiet hours), push text "— S$96 left this week".
- Worker: `GET /api/allowance`, settings (`week_start`, `allowance_override_minor`, `allowance_carry`, `nudge_daily_limit`, `quiet_start`, `quiet_end`), weekly 80/100% alerts (`alert_log` period `YYYY-Www`), nudge gate + `push_outbox` (migration 0004) flushed hourly; budget alerts/digest/email-health now go through the gate (D-49).
- Web: Home Lifestyle card leads with the week (D-51); Settings → Weekly allowance + Notification limit.
- Tests: core `allowance.test.ts` (proration 31/30/28 days, month and year crossings, Sunday 23:59 SGT, sum check, override, carry on/off, safe-to-spend, push text, gate); worker `allowance.test.ts` (API, settings, weekly alert dedupe, gate limit/quiet/flush/coalesce/expiry, post-purchase exempt); web `allowance.test.ts`.

## U — "Vs your usual": DONE
- Core `baseline.ts`: `monthVsUsual` (last 3 complete months with data, days 1..min(d, len)), `weekVsUsual` (last 4 complete weeks, first k days), `compareToUsual` (±5% band), `categoriesVsUsual`, `weekUsualLine`, `monthlyAverage` (used by G/P) (D-52).
- Worker `GET /api/usual` (month: total, Lifestyle, categories; week: total, Lifestyle); weekly digest gains "Lifestyle this week S$210 · usual S$185".
- Web: Home line under the month total (neutral, amber when above), Lifestyle card "Week: about usual", Reports "Vs your usual" per-category card (current month).
- Tests: core `baseline.test.ts` (0/1/2/3+ months, day 31 vs shorter months, trip exclusion, ±5% band, week baseline), worker `usual.test.ts`, web `usual.test.ts`, digest line in `phase5.test.ts`.

## N — Net worth: DONE
- Migration 0005 (nw_accounts, nw_balances + flow_minor, holdings, price_quotes, networth_snapshots, card_statement_paid).
- Core: `decimal.ts` (BigInt decimal strings, quantity × price), `networth.ts` (valuation, card liability, snapshot breakdown, flows vs market D-54, ranges, stale quotes).
- Worker: `prices.ts` (Finnhub → Alpha Vantage fallback, CoinGecko demo key), `networth-job.ts` (06:30 SGT cron + hourly retries to 12:00 then stale carry-forward, idempotent per day), `/api/networth`, `/history`, `/refresh` (≤1 per 5 min), CRUD for accounts/balances/holdings, card statement paid; monthly summary push (1st, 09:00 SGT) with saved vs market.
- Web: Money hub (Net worth / Goals / Plan / Budgets, D-57), Net worth tab (total, 1-month/YTD saved vs market, daily one tap away, stacked area chart, accounts with "update?" chip, cards, holdings, sheets, Refresh now, "Crypto prices by CoinGecko"); Home line "Net worth S$xx,xxx · +S$X this month".
- Tests: core `networth.test.ts` (decimal × price, FX, flows vs market worked example, card liability, stale), worker `networth.test.ts` (mocked Finnhub/Alpha Vantage/CoinGecko/Frankfurter: idempotency, fallback, stale, cards, cron dispatch, summary, API), web `networth.test.ts`.

## Needs David (v2)
- **Price API keys (before deploying N):** create free keys at Finnhub (finnhub.io), Alpha Vantage (alphavantage.co) and CoinGecko (Demo plan), then `npx wrangler secret put FINNHUB_API_KEY`, `ALPHAVANTAGE_API_KEY`, `COINGECKO_API_KEY`. Without a key that source is skipped (stocks fall back to Alpha Vantage; crypto has no fallback).
- Apply migrations 0004+ remotely (`npm run db:migrate:remote`) and deploy; the new 06:30 SGT cron is in `wrangler.jsonc`.
- Enter net-worth accounts, balances and holdings (Money → Net worth).
- Nothing new for A. Optional: Settings → Weekly allowance (week start, fixed amount, carry-over) and Notification limit.
