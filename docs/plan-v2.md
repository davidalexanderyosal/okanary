# Okanary v2: implementation plan (A → U → N → G → W → S → P)

Source brief: `docs/feature-brief-v2.md`. This plan maps it onto the code as it is after Phases 0–5 + Konbini Clay
(commit 15df4ee). Decisions that depart from the brief are listed in §3 and logged in `DECISIONS.md` (D-47 onwards) as
each feature lands.

## 1. What already exists (relevant to v2)

| Brief item | Existing code | Verdict |
|---|---|---|
| Spend definition, money, SGT dates | `core/spend.ts`, `money.ts`, `dates.ts` (`sgtWeekRangeUtc` is Monday-only) | Reuse; generalise the week helper to a configurable week start |
| Monthly Lifestyle budget | `budgets` table (`scope='group', ref_id='lifestyle'`, `effective_from`), `resolveBudgets`, `lifestyleBudget()` | A derives the weekly allowance from it; P writes it |
| Pace / safe-to-spend (month) | `core/pace.ts`, Home Lifestyle card | Month pace stays; Home's "safe to spend today" moves to the week basis (A) |
| Threshold alerts + `alert_log` | `worker/alerts.ts` (unique index `uq_alert_log(kind, ref, period)`) | Monthly alerts unchanged; weekly 80/100% added in A |
| Push sending | `worker/push.ts` `sendPushToAll` | Wrapped by a new nudge gate (limit + quiet hours) in A |
| Post-purchase push | `capture.ts` `pushPurchaseNudge` + `core/nudge.ts` | Text switches to "— S$96 left this week" (A) |
| Weekly digest (Sun 20:00) | `worker/digest.ts` | U adds the "Lifestyle this week S$210 · usual S$185" line |
| Card-cycle maths | `core/cycle.ts`, `/api/cycles`, `billEstimate` (D-31) | N reads card liabilities from it |
| FX (Frankfurter, `fx_rates`) | `worker/fx.ts` `getSgdRate` | N reuses it for USD holdings / non-SGD cash |
| Recurring detection + Subscriptions screen | `recurring` table, `core/recurring.ts` (≥3 charges, 25–36 day gaps), `worker/recurring.ts` (daily cron), `/api/subscriptions*`, `web/pages/Subscriptions.tsx` | S migrates `recurring` → `subscriptions` (one table) and extends detection |
| Email worker + parsers + AI fallback | `worker/email.ts`, `parsers/{dbs,citi,ai}.ts`, `email-auth.ts` (sender allow-list + DKIM) | S adds an UNVERIFIED `apple_receipt` parser + generic receipt fallback |
| Income group | Seed group `income` (Salary, Other income), `counts_as_spend=0` | P reads income transactions for commission logging |
| Goals, net worth, wants, plan, income | — | Nothing exists. No earlier goals table, so G has no data to migrate (its migration test proves this) |
| `behaviour-features.md`, `money-plan-features.md` | Not in the repo | Nothing to archive |
| `CLAUDE.md` | Did not exist | Added with the plan (repo rules for agents) |

Crons today (UTC): `0 * * * *` hourly, `0 18 * * *` (02:00 SGT recurring detection), `0 12 * * 0` (Sun 20:00 SGT digest).

## 2. Cross-cutting infrastructure (built inside A, used by all)

1. **Week helpers** (`core/dates.ts`): `weekStartDate(date, weekStart)`, `sgtWeekRange(now, weekStart)`,
   `isoWeekLabel(date)` → `YYYY-Www` (ISO week of the week's first day; unique per week for any week-start day).
2. **Nudge gate** (`worker/nudge-gate.ts` + table `push_outbox`): `sendNudge(env, deps, payload, {kind})`.
   Post-purchase pushes bypass it. Every other push (budget/weekly alerts, digest, pledges, want-ready, subscription
   pushes, monthly summary, email-health) goes through it:
   - quiet hours (default 23:00–08:00 SGT, settings `quiet_start`/`quiet_end`) → stored in `push_outbox` with
     `send_after` = next 08:00 SGT;
   - daily limit (default 2, setting `nudge_daily_limit`, counted per SGT day from `push_outbox.sent_at`) → over-limit
     pushes are deferred to the next day's 08:00;
   - the hourly cron flushes due rows (still respecting the limit), coalescing rows with the same `tag` (newest wins);
     rows older than 72 h are dropped.
   - pure decision function in core: `nudgeDecision(now, sentToday, limit, quiet)` → `send | hold(until)`.
3. **Cron dispatch**: keep 4 triggers (Cloudflare free plan allows 5): hourly, `30 22 * * *` (06:30 SGT, N prices),
   `0 18 * * *`, `0 12 * * 0`. Time-of-day jobs (Monday 00:00 SGT underspend pledges, 1st-of-month 09:00 SGT summary,
   08:00 outbox flush, want-ready, trial/renewal reminders, N retries until 12:00) run from the hourly trigger,
   dispatched on SGT wall-clock (`hourlyJobs(sgtNow)` pure function in core lists which jobs are due).
4. **Settings** stay in the `settings` key/value table, exposed through `PUT /api/settings` (extended per feature).
5. **Navigation** (D-50): bottom bar = Home · Activity · (+) · Money · Reports. "Money" has top tabs
   **Net worth / Goals / Plan / Budgets** (each its own route: `/money/networth`, `/money/goals`, `/money/plan`,
   `/budgets`). Home keeps spending first and shows one summary line each for net worth, goals and plan.

## 3. Conflicts between brief and code, and resolutions

| # | Conflict | Resolution |
|---|---|---|
| C1 | One subscriptions table, but `recurring` exists and `transactions.recurring_id` has an FK to it | Migration `ALTER TABLE recurring RENAME TO subscriptions` (SQLite rewrites the FK in `transactions` to point at `subscriptions`, verified), rename `cadence→cycle`, `next_expected→next_renewal`, `expected_amount_sgd_minor→expected_sgd_minor` (kept: the expected SGD amount drives price-change checks), add the brief's columns, backfill, drop `merchant/active/confirmed_by_user`. `transactions.recurring_id` keeps its name and now means "subscription id" |
| C2 | Brief's subscription `status` has no state for an unconfirmed detected candidate or a dismissed one | Status set is `candidate, active, trial, cancel_intended, cancelled, dismissed` |
| C3 | Brief detection: ≥2 consecutive months ±15%; code: ≥3 charges | Lower to 2 consecutive monthly charges (gap 25–36 days), keep ±15% / min ±S$1 and the 45-day staleness rule; add weekly/quarterly/yearly only for manual entries |
| C4 | Notification limit applies to "nudges"; code sends budget alerts, digest, email-health immediately | All non-post-purchase pushes go through the nudge gate (§2.2). Post-purchase pushes are exempt from limit and quiet hours (they are the moment-of-spend feedback) |
| C5 | ISO `YYYY-Www` period vs configurable week start | Label = ISO week of the week's first day (§2.1) |
| C6 | Carry-over "within the same month" for weeks that cross months | Carry chains only between consecutive weeks that **start** in the same calendar month; the first week starting in a month never inherits |
| C7 | N: manual-value assets (robo, funds) mix deposits and market growth in one value | `nw_balances` gets nullable `flow_minor`: when given, that part of the change is flow and the rest market; when absent the whole change is flow (the brief's worked example: a balance edit counts as flow). Cash in non-SGD: FX movement on the previous balance is market |
| C8 | N: card liability needs "statement balance until it is marked paid"; nothing records "paid" | New table `card_statement_paid(account_id, statement_date, paid_at)` + "Mark paid" on the card. Also auto-paid when a Card-payment (Transfers) transaction on that card after the statement date covers the bill. Cards without a statement day: liability = bill-estimate charges since the 1st of the current SGT month, labelled "estimate" |
| C9 | N: flows vs market from daily snapshots when holdings history isn't stored | `breakdown_json` stores per-account and per-holding qty, SGD price and value. `market` = Σ prev qty × (SGD price today − SGD price prev) over holdings present on both days + FX on non-SGD cash + manual_asset market part; `flows = Δnet − market` (so the split always adds up) |
| C10 | N: `price_minor INTEGER` loses precision for very cheap coins | Accepted (BTC/ETH-scale assets are fine); documented |
| C11 | G: value from linked assets **and** transferred contributions can double count (a transfer lands in a linked account) | Goal value = Σ share-linked account/holding values + Σ earmarks + (only if the goal has **no** share links) Σ transferred contributions. Contributions are always kept as history |
| C12 | G: PMT_now needs "earmark increases + buys into linked holdings, not market" | PMT_now = (goal value now − goal value 3 months ago − market movement on its links over that window) ÷ months, from `goal_snapshots` + N's per-holding market. Contribution-only goals: avg transferred per month. Less than 3 months of history: use the months available (min 1) |
| C13 | G: emergency target from "last 3–6 months" | Average monthly Essentials over the last up-to-6 complete months with data (needs ≥1; flags "based on N months") |
| C14 | P: Lifestyle floor/cap when there is no Lifestyle history | No history → floor 0 and no cap |
| C15 | P: 20% guilt-free "added to this month's Lifestyle allowance" | New table `lifestyle_bonus(id, week_start, amount_sgd_minor, source, created_at)`; a confirmed guilt-free share is added to the **current week's** allowance (spendable now) |
| C16 | W: early buy must be recorded | `wants.bought_early INTEGER DEFAULT 0` |
| C17 | Brief asks for 3 new tabs; phone tab bar has room for 4 + add | Money hub with top tabs (§2.5) |
| C18 | The `implementer` subagent definition lives on PR #2's branch, not this one | Copied into `.claude/agents/implementer.md` here; if the runtime does not expose the type, the same instructions are passed to a general-purpose agent |
| C19 | Brief says use goals' `horizon` column; it is derived | Stored and refreshed daily by the N job (and on edit); `kind` is the user's choice, `horizon` is computed from `target_date` |
| C20 | Price-change alert "Review" action | Opens the subscription with its recent charges; "Accept new price" sets `amount_minor`/`expected_sgd_minor` to the new charge |

## 4. Feature plans

Each feature = one commit, pushed. Tests named after the brief's "Done when" list. Core maths written by the
orchestrator; routes/UI/cron wiring delegated task-by-task to the implementer and reviewed.

### A — Weekly Lifestyle allowance
Migration `0004_push_outbox.sql`: `push_outbox(id, kind, tag, payload_json, created_at, send_after, sent_at NULL, dropped INTEGER DEFAULT 0)`.

Core (`core/allowance.ts`, `core/dates.ts`, `core/nudge-gate.ts`):
- `weekStartDate`, `sgtWeekRange(now, weekStart)`, `isoWeekLabel`, `addDays` reuse.
- `weekAllowance({weekStart, budgetForMonth(month), override, bonus})`: per month part
  `round(budget × daysInPart / daysInMonth)`, summed; override replaces the derived value.
- `monthAllowanceSum` helper for the sum test (all weeks touching a month, that month's parts only = budget ± 1/part).
- `carryIn(weeks…)` chain (C6); `weekSafeToSpend(allowance, spent, daysLeftInWeek)` floored at 0.
- `weeklyThresholdsReached` (reuse `thresholdsReached`, defaults 80/100).
- `nudgeDecision` (§2.2) and `quietUntil`.
- `purchaseNudgeBody` gains `weekLeftSgd` → "… — S$96 left this week".
Worker: `allowance.ts` (load budgets + week spend via spend definition + settings → `/api/allowance`), weekly alerts in
`alerts.ts` (`alert_log kind='weekly_allowance', ref=threshold, period=YYYY-Www`), `nudge-gate.ts` + outbox flush in hourly
cron, existing alerts/digest/email-health routed through the gate, settings: `week_start`, `allowance_override_minor`,
`allowance_carry`, `nudge_daily_limit`, `quiet_start`, `quiet_end`.
Web: Home Lifestyle card leads with "This week: S$X left of S$Y · resets Mon" + bar with day-of-week marker, month total
smaller below, week-based safe-to-spend; Settings section for the allowance/notification settings.
Tests: proration 31/30/28-day months, weeks crossing month and year, Sunday 23:59 SGT in-week, sum check, override,
carry on/off, safe-to-spend, alert dedupe (twice → one row/push), gate limit + quiet-hours hold + flush.

### U — "Vs your usual"
No migration. Core `core/baseline.ts`:
- `monthBaseline(rows, now, filter)`: last 3 complete months **with data**, spend over days 1..min(d, len); returns
  `{usual, months}`; 0 months → null.
- `weekBaseline(rows, now, weekStart, filter)`: last 4 complete weeks, first k days (k = days elapsed incl. today).
- `compareToUsual(current, usual)` → `{state: 'about'|'above'|'below'|'no_history', pct, diff}` with the ±5% band.
- Filters: total, group (Lifestyle), each category. Trip-excluded rows already drop out via the spend definition.
Worker: `/api/usual` (month total, Lifestyle month + week, categories), digest line.
Web: Home line under the month total (neutral/amber), Lifestyle card "Week: about usual", Reports "vs usual" table
sorted by largest increase.
Tests: 0/1/2/3+ months, day 31 vs shorter months, trip exclusion, ±5% band, week baseline.

### N — Net worth
Migration `0005_networth.sql`: brief tables `nw_accounts`, `nw_balances` (+`flow_minor`), `holdings`, `price_quotes`,
`networth_snapshots`, plus `card_statement_paid` (C8). Indexes on `nw_balances(account_id, as_of)`, `holdings(account_id)`.
Core: `core/decimal.ts` (parse/normalise decimal strings, add/sub, `mulDecimalByMinor` half-up), `core/networth.ts`
(`holdingValueSgd`, `accountValueSgd`, `cardLiability(cycle rows, paid)`, `buildSnapshot`, `splitFlowsMarket(prev, cur)`,
`changeOverRange(snapshots, from, to)`, `staleQuote` rules, `quoteForDay` fallback order).
Worker: `prices.ts` (Finnhub → Alpha Vantage fallback per ticker, CoinGecko `simple/price` with `x-cg-demo-api-key`,
`deps.fetch` only), `networth-job.ts` (06:30 SGT cron + hourly retry until 12:00, then keep last price as stale;
idempotent per date; writes `goal_snapshots` once G exists), routes `/api/networth/*` (accounts, balances, holdings,
refresh-now ≤1 per 5 min, history, card mark-paid), monthly summary push (1st, 09:00 SGT, via gate).
Secrets: `FINNHUB_API_KEY`, `ALPHAVANTAGE_API_KEY`, `COINGECKO_API_KEY` (optional in code; missing key → source skipped).
Web: Money → Net worth: total + 1-month/YTD change cards split saved vs market, daily change one tap away, stacked area
chart by asset class, accounts with as-of age + "update?" chip (>30 days), holdings table, add/edit sheets, CoinGecko
attribution. Home: "Net worth S$xx,xxx · +S$X this month".
Tests: decimal × price, FX, snapshot idempotency, flows vs market worked example, card liability from cycle data,
stale-price handling, Finnhub→Alpha Vantage fallback (mocked fetch).

### G — Goals
Migration `0006_goals.sql`: brief tables `goals`, `goal_funding`, `goal_snapshots`, `goal_contributions` (+ unique index
on `goal_contributions(goal_id, source, period)` for `source='underspend'` dedupe via partial unique index; partial
unique index enforcing a single `receives_underspend = 1`), `planned_monthly_minor` column on goals (set by P).
Core `core/goals.ts`: `monthlyRate(bp)`, `inflateTarget`, `requiredMonthly`, `projectedValue`, `monthsToReach`
(≤600 months else null), `goalStatus` (on_track / behind / ahead + amounts), `projectionRange` (±2 pp for long goals),
`horizonFor(targetDate, today)`, `saferFundingPrompt`, `retirementTarget(monthly)`, `emergencyTarget(monthly essentials)`,
`goalValue(funding, nw values, contributions)` (C11), `fundingWarnings` (earmarks > balance, shares > 100%),
`goalPace` (C12), `underspendPledgeAmount`, `defaultUnderspendGoal`.
Worker: `/api/goals*` (CRUD, reorder, funding links, contributions: transfer/skip/manual), Monday 00:00 SGT underspend
job (idempotent), pledge push "Last week you came in S$80 under. Move S$80 to 🇯🇵 Japan trip?" (gate), daily
goal_snapshots + horizon refresh + one-time safer-funding prompt from the N job.
Web: Money → Goals: cards grouped Short/Mid/Long (progress bar = transferred/linked value only, pledged shown apart),
status chip, required vs current monthly, editor, detail with projection chart (+cone for long goals) and contribution
history, assumptions + "Estimates, not financial advice." Home: "Goals: 4 on track · 1 behind (MBA −S$120/mo)".
Tests: the brief's list, incl. a migration test that the goals tables are created empty and pre-existing data is intact.

### W — Want list
Migration `0007_wants.sql`: brief `wants` + `bought_early`.
Core `core/wants.ts`: `defaultWaitDays(priceSgd, threshold)`, `decideAfter(addedAt, waitDays)` (00:00 SGT of added SGT
date + wait), `transition(status, action, now)`, `readyBatchBody(items)`, `skippedTotal(wants, year)`,
`suggestTransactionMatch(want, txns)` (±10% amount, ±14 days).
Worker: `/api/wants*`, hourly ready job (one batched push via gate), skip → optional pledge (`want_skipped`).
Web: Want list screen (Waiting/Ready/Decided, countdowns, quick add), "Want, not buy" in Quick add and on Home,
"Not bought this year" stat on Home/Reports.
Tests: brief list.

### S — Subscriptions hub
Migration `0008_subscriptions.sql`: rename `recurring` → `subscriptions` (C1/C2), add columns, backfill, drop legacy
columns, `subscription_events`, index on `subscriptions(merchant_pattern)`.
Core `core/subscriptions.ts`: `monthlyEquivalent`, totals (month/year, Essentials vs Lifestyle), detection (C3),
`priceChange(expected, chargedSgd, foreign)` threshold `max(2%, S$0.50)` (+3% if foreign), `missingCharge`,
`trialReminderDue` (2 days before, SGT), `renewalReminderDue` (7 days, yearly), `annualSetAside`,
`goalImpact(sub, goal)`, `mergeCandidate(manual, detected)`, `catalogue` (with cancel URLs).
Worker: migrate `/api/subscriptions*` to the new table (+ manual add/edit/cancel-intent/accept-price), capture hook for
price-change + `last_charged`, daily reminders/missing flags, quarterly usage check (gate), new-candidate push,
`parsers/apple-receipt.ts` (UNVERIFIED, `synthetic-apple-receipt*.txt`) + APPLE.COM/BILL matching (±3 days, same amount),
generic receipt → AI fallback → Review inbox. Apple sender domains added to the allow-list with DKIM check.
Web: Subscriptions hub (totals, list with monthly equivalent, cost in goal terms, flags, add from catalogue, trials).
Tests: brief list.

### P — Income & plan
Migration `0009_plan.sql`: brief `income_settings`, `income_events`, `plans`, plus `lifestyle_bonus` (C15).
Core `core/plan.ts`: `buildPlan(inputs)` (fixed = subs monthly eq + set-asides + essentials baseline w/o subs + line
overrides; goals waterfall; L; floor/cap; overflow to goals; trade-offs: extend lowest-priority dates, lower Lifestyle
with implied weekly allowance, commission coverage when ≥3 months of history; percentages summing to 100 with
largest-remainder rounding; 50/30/20 and 60/20/20 context), `commissionSplit(amount, rule, goals)`.
Worker: `/api/income*`, `/api/plan*` (compute, accept → writes Lifestyle budget + goals' planned monthly; manual
override flag), commission logging (button + from Income transactions), monthly check-in in the 1st-of-month summary.
Web: Plan tab (income card, split bar, per-goal list, trade-off cards, assumptions, disclaimer) + onboarding wizard.
Tests: brief list.

## 5. Data migrations summary

| File | Feature | Data movement |
|---|---|---|
| 0004_push_outbox.sql | A | none |
| 0005_networth.sql | N | none (new tables) |
| 0006_goals.sql | G | none: no earlier goals table exists (test asserts tables empty + existing data untouched) |
| 0007_wants.sql | W | none |
| 0008_subscriptions.sql | S | `recurring` rows → `subscriptions` in place (ids kept so `transactions.recurring_id` stays valid): name/merchant_pattern ← merchant, amount ← expected SGD, currency SGD, cycle ← cadence, next_renewal ← next_expected, status ← dismissed if `active=0`, active if confirmed, else candidate, source detected |
| 0009_plan.sql | P | none |

## 6. Secrets / things only David can do
- `wrangler secret put FINNHUB_API_KEY`, `ALPHAVANTAGE_API_KEY`, `COINGECKO_API_KEY` (free/demo keys).
- A real redacted Apple subscription receipt in `worker/fixtures/` to verify the Apple parser.
- Apply migrations 0004–0009 remotely and deploy (not done here).
- Gmail filter forwarding Apple (and service) receipts to `spend@`.
- Run the Plan onboarding wizard; enter net-worth accounts/holdings.

## 7. Verification per feature
`npm test` (all workspaces) exit 0 · `npm run build` exit 0 · `npm run db:migrate:local` applies the new migration ·
the feature's "Done when" tests exist and pass (named in the commit message) · PROGRESS.md, okanary-spec.md, DECISIONS.md
updated · one commit, pushed to `claude/cool-goldberg-e9ec40`.
