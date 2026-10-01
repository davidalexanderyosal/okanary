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

## Needs you (cumulative)
- iPhone test of Home-Screen install + Quick add feel (safe areas, keyboard).
- Secrets for Phase 2: `INGEST_TOKEN` (or generate in the app's Setup page), VAPID keys via `npm run vapid` → `wrangler secret put VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/VAPID_SUBJECT`.
- Cloudflare Access: add a Bypass policy for path `/api/ingest/applepay` so the Shortcut can reach it (token-protected). Optional WAF rate-limit rule on that path.
- iPhone: build the Shortcuts Wallet automation using the in-app Setup page; Wallet card names must match Settings → account → Apple Wallet card name.
- Cloudflare: create D1, put real `database_id` in `wrangler.jsonc`, deploy, set up Access (commands will be in the final summary).
