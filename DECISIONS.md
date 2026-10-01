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
