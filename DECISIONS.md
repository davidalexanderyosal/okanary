# Decisions

Format: **ID — decision** · reason · alternatives.

- **D-01 — Savings, Income, Transfers have `counts_as_spend = 0`; Essentials and Lifestyle = 1.** Spec §6 lists Transfers as "excluded" and "Spent this month" is about outflow on consumption; Savings are shown as a Home bar but don't inflate spend. · Alt: Savings counts as spend (would make saving look like overspending).
- **D-02 — Uncategorised (no category → no group) transactions count as spend.** Spec says pending items still count in totals; hiding un-reviewed purchases would defeat the awareness goal. They appear under the synthetic `uncategorised` bucket. · Alt: exclude until categorised.
- **D-03 — Migration 0001 adds constraints beyond the §6 column list: `NOT NULL`, FK `REFERENCES`, defaults, and `CHECK (amount_minor >= 0 AND amount_sgd_minor >= 0)`.** No columns added/removed. Sign is carried by `is_refund`, as the spend definition says "refunds counted as negatives". · Alt: signed amounts.
- **D-04 — Single deploy via Workers Static Assets** (`assets` in wrangler.jsonc, SPA fallback, `run_worker_first: ["/api/*"]`), not Pages. · Spec allows either; this is one `wrangler deploy`.
- **D-05 — Month summaries are computed in JS from rows via `@okanary/core`** (`summarizeMonth`), not in SQL, so there is exactly one implementation of the spend definition. Personal-scale data (hundreds of rows/month) makes this cheap. · Alt: SQL view duplicating the predicate.
- **D-06 — SGT implemented as fixed UTC+8** (Singapore has had no DST since 1982), cross-checked against `Intl` in tests. · Alt: Intl everywhere (slower, same result).
- **D-07 — FX rates are stored as REAL (spec §6) but converted via scaled BigInt in `convertMinor`**, so money is never float-multiplied. 
- **D-08 — Phase 1 is SGD-first:** non-SGD transactions via the API must supply `amount_sgd_minor` (`fx_source='manual'`); automatic FX arrives in Phase 4.
- **D-09 — IDs are ULIDs** generated in the Worker (sortable, no coordination).
- **D-10 — Transaction delete is a hard delete** in Phase 1 (manual entries); `void` status remains for auto-captured items.
- **D-11 — Branching:** the first scaffold commit (331c240) was accidentally pushed to `main`; all further work goes to `claude/okanary-phases-0-5`. `main` was not rewritten (no force-push without the owner's say-so).
- **D-12 — A bare `$` in a Shortcut amount means SGD; `US$` is USD.** The user is Singapore-based and spec §9 lists `$8.90` as an example. · Alt: USD.
- **D-13 — If a foreign-currency capture has no obtainable FX rate (fresh fetch failed and nothing cached), the transaction is still saved, `status='needs_review'`, `amount_sgd_minor=0`, with a note.** Dropping it would lose the record; 0 SGD is flagged in the review inbox until the user sets the SGD amount. · Alt: reject the request.
- **D-14 — Review inbox = non-void, non-excluded rows that are uncategorised, carry only an AI suggestion (`category_source='ai'`), or are `status='needs_review'`** (+ failed raw_ingest rows). No schema flag exists for "suggestion" so `category_source` carries it. A user category choice sets `category_source='user'`, removing it from the inbox.
- **D-15 — Ingest token:** a token generated/rotated in the app is stored in D1 `settings.ingest_token` and, when present, is the ONLY valid token (rotation revokes the old one, incl. the bootstrap `INGEST_TOKEN` secret). The secret is only a bootstrap value. The Setup page shows it to the Access-authenticated owner. · Alt: secret only (not rotatable from Settings, contradicting spec §5).
- **D-16 — Ingest rate limit is an in-isolate 60/min counter** (best effort). A hard limit needs a Cloudflare WAF rate-limiting rule; documented in the deploy steps.
- **D-17 — Retried identical Shortcut POSTs (same raw payload within 5 min) return the original transaction (HTTP 200) instead of creating a duplicate.** Not the Phase 3 Apple Pay↔email merge.
- **D-18 — `AI` binding is in `wrangler.jsonc` (for deploy) but NOT in `wrangler.dev.jsonc`,** because `wrangler dev` always proxies AI to remote Cloudflare, which is off-limits for local work. The code treats AI as optional; tests inject a fake. Local `npm run dev` therefore has no AI suggestions.
- **D-19 — `merchant` stores the normalised name; `merchant_raw` the text as received/typed**, for manual entries too, so history/rule lookups are consistent. UI shows a title-cased version.
- **D-20 — Custom service worker (`injectManifest`)** for push/notificationclick instead of generateSW.
- **D-21 — Push payload lifestyle total uses the Lifestyle group budget from `budgets` when one exists** (table is read now; budgets UI is Phase 4), else shows spend only.
