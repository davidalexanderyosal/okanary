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

## Needs you (cumulative)
- iPhone test of Home-Screen install + Quick add feel (safe areas, keyboard).
- Cloudflare: create D1, put real `database_id` in `wrangler.jsonc`, deploy, set up Access (commands will be in the final summary).
