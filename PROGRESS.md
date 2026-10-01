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
- Cloudflare: create D1, put real `database_id` in `wrangler.jsonc`, deploy, set up Access (commands will be in the final summary).
