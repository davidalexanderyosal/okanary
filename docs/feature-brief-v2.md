# Okanary — Feature Brief v2 (combined)

> Put this file in the repo at `docs/feature-brief-v2.md` and commit it. It **replaces** `behaviour-features.md` and `money-plan-features.md`: delete those from the repo, or keep them in `docs/archive/`, so Claude Code only sees one brief.

## What this adds

| Code | Feature | Why | Evidence |
|---|---|---|---|
| **A** | Weekly Lifestyle allowance | Smaller budgets give a fresh start each week | Soman & Cheema: partitioning ≈ +70% saved |
| **U** | "Vs your usual" comparison | A benchmark makes overspending visible | D'Acunto, Rossi & Weber: overspenders cut discretionary spend |
| **N** | Net worth | One honest number, split into "you saved" vs "market" | Gneezy & Potters: show investment results calmly, not daily |
| **G** | Goals (short to long term) with on-pace projection and pledges | Concrete goals plus progress monitoring | Gargano & Rossi: goal setting raises saving |
| **W** | Want list with a waiting timer | Delay before impulse buys | Weak but cheap |
| **S** | Subscriptions hub, incl. price-change alerts | Recurring charges get no DBS alerts; APPLE.COM/BILL hides which app | Practical |
| **P** | Income & personalised plan | Turns income and goals into a Lifestyle budget | Budget on base pay; commission to goals |

**Build order: A → U → N → G → W → S → P.** Each depends only on earlier ones: W's "skip → goal" needs G; P needs everything.

**If some of this is already built** (e.g. from the earlier behaviour brief), keep what works, adapt it to this brief, and migrate data. There must be **one goals system** and **one subscriptions table**.

---

## Rules for Claude Code (apply to every feature)

- Read `CLAUDE.md`, `okanary-spec.md`, `PROGRESS.md`, `DECISIONS.md` and the existing code before planning. Reuse existing patterns: the shared spend definition, money and SGT date helpers, push sending, alert_log, cron setup, UI components.
- Money in integer minor units; holdings quantities as decimal strings with a decimal helper (never floats). All day, week and month boundaries in Asia/Singapore.
- **New migration files only.** Never edit old migrations.
- **One source of truth per number.** Goal values come from linked net-worth assets or transferred contributions. Fixed costs come from S. Essentials and Lifestyle baselines come from the spend definition plus U.
- **Deterministic maths.** All plan, projection and allowance calculations are pure, unit-tested functions in `/packages/core`. AI may only phrase an explanation of computed numbers.
- **Visible assumptions.** Projection and plan screens show their assumptions (returns, inflation, emergency months) with an edit link, plus the footer "Estimates, not financial advice."
- **Tone:** neutral or encouraging, never shaming (the "ostrich effect": people avoid checking finances when things look bad). Amber, not red, for "above usual".
- **Notification limit:** besides post-purchase pushes, at most **2 nudge pushes per day**; quiet hours 23:00–08:00 SGT (held until 08:00). Both configurable. No pushes about daily market moves.
- **Home stays spending-first.** Net worth, goals and plan get their own tabs; Home shows one summary line each.
- External APIs are tested with mocked fetch only. Do not deploy.
- One commit per feature, pushed. After each feature update `PROGRESS.md` and `okanary-spec.md`, and log any departure from this brief in `DECISIONS.md`.

---

## How everything connects

```
                 Income (base + commission)
                          │
                          ▼
   Subscriptions (S) ─► PLAN ENGINE (P) ◄─ Spending history (U: essentials & lifestyle baselines)
     fixed costs          │       │
                          │       └──► planned monthly contribution per goal ──► GOALS (G)
                          ▼                                                       ▲  ▲  ▲
               Lifestyle budget ──► A: weekly allowance                           │  │  │
                          │                                                       │  │  │
                 unspent allowance (A) ───────── pledge ──────────────────────────┘  │  │
                 skipped wants (W) ───────────── pledge ─────────────────────────────┘  │
                 commission split (P) ────────── pledge ────────────────────────────────┤
                                                                                        │
   NET WORTH (N): cash, US stocks, BTC, minus credit-card balances ─ linked funding ────┘
```

---

## A — Weekly Lifestyle allowance

**What it does:** turns the monthly Lifestyle budget into a weekly allowance that resets every Monday, so one bad week doesn't write off the month.

**Rules**
- Week = Monday 00:00 to Sunday 23:59:59 SGT. Week start day is a setting (default Monday).
- Weekly allowance is derived from the monthly Lifestyle budget, prorated by days:
  `allowance(week ∩ month) = monthly_budget × days_of_week_in_this_month ÷ days_in_month`.
  For a week that spans two months, use each month's budget for its own days and add the two parts. Do the integer arithmetic carefully: round per part to the nearest minor unit, and test that a full month's allowances sum to the monthly budget within rounding.
- Optional manual override: a fixed weekly amount in Settings replaces the derived value.
- **Fresh start by default:** overspend does not carry into next week. A setting "Carry unspent/overspent amount to next week (within the same month)" defaults to off.
- "Safe to spend today" on Home switches to the week basis: `(allowance − spent this week) ÷ days left in the week including today`, floored at 0.

**UI**
- The Home Lifestyle card leads with the week: **"This week: S$X left of S$Y · resets Mon"**, with a progress bar and the day-of-week marker. Show the month total below it, smaller.
- The post-purchase push uses the week: "S$14.50 · Ya Kun · Coffee — S$96 left this week".

**Alerts**
- Weekly threshold pushes at 80% and 100% of the allowance, once per week each (use alert_log with period `YYYY-Www`).
- The existing monthly budget alerts stay as they are.

**Done when (tests):** proration (31-, 30- and 28-day months, weeks crossing month and year boundaries), SGT boundaries (a purchase at Sunday 23:59 SGT belongs to that week), sum check, override, carry-over on/off, safe-to-spend math, alert deduplication.

---

## U — "Vs your usual" comparison

**What it does:** compares spending so far in the current period with what David usually spends by the same point.

**Rules**
- **Month baseline:** for today's day-of-month `d`, take spend over days 1..`min(d, month_length)` in each of the last **3 complete months that have data**, and average them. With fewer than 3 such months, use what exists and show "based on N months". With 0 months, show "Not enough history yet".
- **Week baseline:** the same idea, using the average spend from the start of the week to the same weekday and time-of-day point across the last 4 complete weeks. Day granularity is fine.
- Computed for the total, Lifestyle, and each category (the category level is shown in Reports only).
- Excluded trips are left out of both the current period and the baseline.
- Difference shown as a percentage and an amount. Under ±5% shows as "about usual".

**UI**
- Home, under the month total: **"S$640 so far · 12% below your usual by day 14"** (neutral colour), or "18% above your usual" (amber).
- Lifestyle card: one line, "Week: about usual" / "Week: S$40 above usual".
- Reports: per-category bar or table, this month to date vs usual, sorted by largest increase.
- Weekly summary push includes one line: "Lifestyle this week S$210 · usual S$185".

**Done when (tests):** baseline with 0, 1, 2 and 3+ months of history; day 31 against shorter previous months; trip exclusion; the ±5% band; week baseline.

---

## N — Net worth

**Purpose:** one honest number for "what I own minus what I owe", updated daily without manual work for stocks and BTC, and split so David can see how much of the change came from **his saving** versus **the market**.

### Assets and liabilities
- **Cash accounts**: e.g. bank savings, e-wallets, brokerage cash, cold cash. Manually entered balance plus `as_of` date. Each has a currency (SGD/USD/IDR/JPY).
- **US stocks/ETFs**: holdings entered as ticker, quantity and optional cost basis per lot, grouped by broker.
- **Crypto**: BTC to start (support any CoinGecko id), quantity and optional cost basis.
- **Manual-value assets**: robo-advisor or fund accounts and anything without a ticker. Value plus `as_of`.
- **Liabilities**: **credit card balances come automatically from Okanary's card-cycle data** (spent since the last statement, plus the statement balance until it is marked paid). Manual liabilities (loans) are optional.

### Prices (no SDK needed; plain `fetch` from the Worker)
| Data | Source | Free tier | Notes |
|---|---|---|---|
| US stock/ETF prices | **Finnhub** `/quote` (primary) | 60 calls/min, US only | Store the previous close and the current price |
| US prices fallback | **Alpha Vantage** `GLOBAL_QUOTE` | 25 calls/day, 5/min | Used only if Finnhub fails for a ticker |
| BTC and other crypto | **CoinGecko** `/simple/price` (Demo key) | ~10k calls/month | **Attribution required**: show "Crypto prices by CoinGecko" on the net worth screen |
| FX (USD/IDR/JPY → SGD) | **Frankfurter** (already used) | No key | Reuse the existing fx_rates table |

- Do **not** use `yahoo-finance2` or other unofficial Yahoo scrapers. They are unofficial and fragile, and Cloudflare Workers support is incomplete.
- API keys are Worker secrets: `FINNHUB_API_KEY`, `ALPHAVANTAGE_API_KEY`, `COINGECKO_API_KEY`. Document in PROGRESS.md that David must create them.
- **Daily job (cron 06:30 SGT, after the US close)**: fetch prices for all held tickers and coins, convert to SGD, write `price_quotes`, then write one `networth_snapshots` row for the day. Safe to run twice. Failures are retried hourly until 12:00 SGT, then the last price is kept and marked stale.
- A "Refresh now" button runs the same job manually, at most once per 5 minutes.

### Data (new migration)
```sql
nw_accounts(id TEXT PK, name TEXT, kind TEXT CHECK(kind IN ('cash','brokerage','crypto','manual_asset','liability')),
  institution TEXT, currency TEXT, include_in_networth INTEGER DEFAULT 1, archived INTEGER DEFAULT 0)
nw_balances(id TEXT PK, account_id TEXT FK, amount_minor INTEGER, currency TEXT, as_of TEXT, note TEXT)   -- history of manual balances
holdings(id TEXT PK, account_id TEXT FK, asset_type TEXT CHECK(asset_type IN ('us_equity','crypto')),
  symbol TEXT, quantity TEXT,                 -- decimal string (crypto needs 8+ dp); use a decimal helper, not floats
  cost_basis_minor INTEGER NULL, cost_currency TEXT NULL, acquired_at TEXT NULL)
price_quotes(symbol TEXT, asset_type TEXT, date TEXT, price_minor INTEGER, currency TEXT,
  prev_close_minor INTEGER NULL, source TEXT, stale INTEGER DEFAULT 0, PRIMARY KEY(symbol, asset_type, date))
networth_snapshots(date TEXT PK, assets_sgd_minor INTEGER, liabilities_sgd_minor INTEGER, net_sgd_minor INTEGER,
  breakdown_json TEXT,           -- per account / asset class
  flows_sgd_minor INTEGER,       -- manual balance changes, buys/sells entered that day (David's own money moving)
  market_sgd_minor INTEGER)      -- price and FX movement on existing holdings
```

### Change tracking: daily data, calm display
Research note: checking investment results more often makes people more loss-averse and leads to worse decisions. In Gneezy & Potters' experiment, people given feedback every round took less risk and earned less than those given feedback every three rounds. So:
- **Store daily, display calmly.** The net worth screen leads with the total and the **1-month / YTD change**, split into "You saved +S$X" and "Market +/−S$Y".
- **Daily change** is one tap away ("Today: +S$120 · market"). It is shown on the net worth screen only, **never pushed**, and never on Home.
- Home shows one line: "Net worth S$xx,xxx · +S$X this month".
- **Monthly summary push** (1st of month, 09:00 SGT): net worth change split into saved vs market, plus goal status (from G).

### UI
Net worth tab with:
- Total and change cards.
- A stacked area chart over time by asset class (cash / stocks / crypto / other / −liabilities).
- An accounts list showing the `as_of` age. Balances older than 30 days get a quiet "update?" chip, plus one reminder in the monthly summary.
- Holdings table: price, value in SGD, gain (if cost basis exists) and today's move.
- Add/edit sheets for accounts, holdings and balances.

### Done when (tests)
- Decimal quantity × price maths.
- FX conversion.
- Snapshot idempotency.
- Flows vs market split. Worked example: a balance edit counts as flow; a price change counts as market.
- Card liability pulled from the card-cycle data.
- Stale-price handling.
- Finnhub → Alpha Vantage fallback, using mocked fetch.

---

## G — Goals (short-term and long-term), with on-pace projection

**Purpose:** let David set goals of any length, see whether he is on pace, and get a concrete "save S$X more per month" answer when he isn't.

### Goal types
| Horizon | Examples | Default funding | Default growth assumption |
|---|---|---|---|
| **Short (< 2 years)** | Holiday, big-ticket item, MBA application costs | Cash | Cash return (default 2% p.a., editable) |
| **Mid (2–10 years)** | MBA tuition, wedding, house down payment | Cash/bonds mix | Default 4% p.a. (editable) |
| **Long (10+ years)** | Retirement | Investments | Default 6% p.a. (editable) |

Horizon is derived from the target date and recalculated as time passes. A goal crossing below 2 years triggers **"Move to safer funding?"**: a one-time suggestion to fund it from cash instead of stocks/crypto. Money needed soon shouldn't depend on market swings.

**Emergency fund (auto-suggested, priority 1):** target = **6 × average monthly Essentials spend** (computed from the last 3–6 months of actual spending, not guessed). Six months rather than three because part of David's pay is commission. Funded from cash only.

### Target amounts
- Short goals: a fixed amount.
- Mid/long goals are entered **in today's dollars**. The app inflates them to the target date with a per-goal inflation rate: default 3% p.a., editable. Education and weddings often rise faster, so the editor suggests "consider 4–5%". Both amounts are shown: "S$60,000 today ≈ S$69,600 in 2031."
- Retirement uses a simple helper: desired monthly spending in today's dollars × 12 × 25 (the "4% rule"). It is shown as an editable estimate, labelled as a rule of thumb.

### Funding sources (integration with N)
A goal's current value comes from one or more of:
- **Linked net-worth accounts or holdings**, fully or as a fixed share. Example: "Retirement = 100% of US stocks + 100% of BTC". "Holiday = S$1,500 earmarked inside DBS savings" uses an earmark amount on a cash account.
- **Transferred contributions** (from A underspend pledges, W skipped wants, and manual entries). These are `goal_contributions` (see Pledges below).

Checks: earmarks on one account can't add up to more than its balance, and linked shares of one holding can't exceed 100%. Show a warning when they do.

### Projection maths (`/packages/core/goals.ts`, fully unit-tested)
For each goal with monthly rate `r = (1+annual)^(1/12) − 1`, months left `n`, current value `PV` and target `FV`:
- **Required monthly** `PMT_req = (FV − PV·(1+r)^n) · r / ((1+r)^n − 1)`. When `r = 0`, use `(FV − PV)/n`. Floor at 0.
- **Current pace** `PMT_now` = average net monthly contribution over the last 3 months (transfers, earmark increases, and buys into linked holdings; market gains are not counted).
- **Projected value at target date** `= PV·(1+r)^n + PMT_now · ((1+r)^n − 1)/r`.
- **Projected completion date** at current pace (solve for `n`; show "not reached within 50 years" when appropriate).
- **Status:** *On track* (projected ≥ target), *Behind* (show "+S$X/month to finish on time" and "or finish in MMM YYYY at current pace"), or *Ahead* (by how much).
- **Range for long goals:** show conservative / base / optimistic projections at return −2 / base / +2 percentage points. Never present a single number as certain.

### Pledges (Okanary can't move money)
Money headed to a goal is first **pledged**; David moves it himself and taps **Transferred** (or **Skip**).
- **Weekly underspend (from A):** a cron job on Monday shortly after 00:00 SGT computes `max(0, allowance − Lifestyle spent)` for the week that just ended. If it's above 0 and a goal has `receives_underspend`, create a pledge. Safe to run twice. Push: "Last week you came in S$80 under. Move S$80 to 🇯🇵 Japan trip?" with **Transferred** / **Skip**.
- **Skipped wants (from W)** and **commission splits (from P)** create pledges the same way.
- Ignored pledges stay pledged and are listed on the goal screen.
- **Progress counts transferred money only.** Pledged amounts show separately ("S$120 pledged, not yet moved"), so the progress bar stays honest.

### Priority
Goals have an explicit order (drag to reorder). The plan engine (P) funds them **in priority order** (waterfall). Emergency fund defaults to first.

### UI
- Goals tab: cards grouped Short / Mid / Long, each with a progress bar, status chip, required vs current monthly, target date and funding sources.
- Goal editor: name, emoji, type, target (today's dollars), date, inflation, return assumption, funding links, priority.
- Goal detail: projection chart (actual line plus projected cone for long goals) and contribution history.
- Home: one line, "Goals: 4 on track · 1 behind (MBA −S$120/mo)".
- A underspend pledges go to the goal marked `receives_underspend`. The default is the highest-priority goal that is behind.

### Data (new migration; if an earlier goals table exists, migrate its data into this one)
```sql
goals(id TEXT PK, name TEXT, emoji TEXT, target_sgd_minor INTEGER, target_date TEXT NULL,
  receives_underspend INTEGER DEFAULT 0, archived INTEGER DEFAULT 0, created_at TEXT,
  horizon TEXT, priority INTEGER, target_today_minor INTEGER, inflation_bp INTEGER,
  return_bp INTEGER, kind TEXT CHECK(kind IN ('emergency','short','mid','long','retirement')),
  start_date TEXT)
goal_funding(id TEXT PK, goal_id TEXT FK, source_type TEXT CHECK(source_type IN ('nw_account','holding','earmark')),
  source_id TEXT, share_bp INTEGER NULL, earmark_minor INTEGER NULL)
goal_snapshots(goal_id TEXT, date TEXT, value_sgd_minor INTEGER, PRIMARY KEY(goal_id, date))   -- written by the daily N job
goal_contributions(id TEXT PK, goal_id TEXT FK, period TEXT,       -- 'YYYY-Www', 'YYYY-MM' or 'manual'
  amount_sgd_minor INTEGER,
  source TEXT CHECK(source IN ('underspend','want_skipped','commission','manual')),
  status TEXT CHECK(status IN ('pledged','transferred','skipped')),
  created_at TEXT, resolved_at TEXT NULL)
```
Only one goal can have `receives_underspend = 1` at a time.

### Done when (tests)
- PMT with r = 0 and r > 0.
- Inflation of the target.
- Projected completion date.
- Status thresholds.
- Earmark over-allocation warning.
- Funding value from linked holdings at a share.
- Emergency target from the essentials baseline.
- Horizon re-classification with the "safer funding" prompt.
- Underspend pledge calculation; the job running twice creates no duplicate; no receiving goal means no pledge.
- Progress counts transferred contributions only.
- Migration of any earlier goals data.

---

## W — Want list with a waiting timer

**What it does:** puts a delay between wanting something and buying it, and tracks what David decided not to buy.

**Data (new migration)**
```sql
wants(id TEXT PK, name TEXT, price_minor INTEGER, currency TEXT, price_sgd_minor INTEGER,
      url TEXT NULL, note TEXT NULL, category_id TEXT NULL,
      wait_days INTEGER, added_at TEXT, decide_after TEXT,
      status TEXT CHECK(status IN ('waiting','ready','bought','skipped')),
      decided_at TEXT NULL, transaction_id TEXT NULL)
```

**Rules**
- Wait options: 3, 7 (default), or 30 days, or custom. Default 7; above S$200 the default is 30 (threshold configurable).
- When `decide_after` passes, status becomes `ready` and a push is sent: "Still want AirPods case (S$59)? Buy / Skip". This counts toward the daily nudge limit, and several ready items are batched into one push.
- **Skip** marks the item skipped and offers "Add S$59 to 🇯🇵 Japan trip?", which creates a pledge (`source = want_skipped`, see G).
- **Buy** marks the item bought. Optionally link it to a transaction later: suggest a match on amount ±10% within 14 days.
- Buying early from the waiting state is allowed but asks once: "Bought before the wait ended?". Record it; no shaming.

**UI**
- "Want list" screen with tabs Waiting / Ready / Decided, a countdown per item, and quick add (name, price, wait).
- Entry points: a **"Want, not buy"** button in the Quick add sheet and on Home.
- Home/Reports stat: **"Not bought this year: S$412 (9 items)"**.

**Done when (tests):** decide_after calculation in SGT, status transitions, batching of ready items, the skipped total, the transaction match suggestion.

---

## S — Subscriptions hub

**Purpose:** a complete list of every recurring charge, however it's billed, feeding fixed costs into the plan and showing each subscription's cost in terms of goals.

### Ways a subscription gets in (all lead to one `subscriptions` table)
1. **Detected from card transactions.** Use existing recurring detection if the spec's Phase 5 built it; otherwise build it: the same normalised merchant seen in ≥ 2 consecutive months with amounts within ±15% → a candidate David confirms or dismisses. New candidate → one push: "New subscription? Spotify S$11.98/month".
2. **Manual add** with a small built-in catalogue of common services (Netflix, Spotify, YouTube Premium, iCloud+, ChatGPT, Claude, Google One, Disney+, gym, phone plan…). Fields: price, currency, cycle (weekly / monthly / quarterly / yearly), next renewal date, card, category.
3. **Apple-billed subscriptions.** These all show on the card as `APPLE.COM/BILL`, so the transaction alone can't say which app it is. Fix: a Gmail filter forwards Apple receipt emails to `spend@` (and Google Play receipts, if any). The email Worker gets an `apple_receipt` parser that extracts app or subscription name, price and date, then matches it to the APPLE.COM/BILL transaction (same amount within ±3 days) and labels it. Add the parser framework now and mark it **UNVERIFIED until David supplies a real receipt sample**, same as the bank parsers.
4. **Service receipt emails** (Netflix, Spotify, etc.) forwarded the same way. A generic "receipt" fallback parser can use the existing LLM-fallback path and goes to the Review inbox.
5. **Free trials.** Add a trial with its end date and the price after the trial. Reminder **2 days before it ends**: "ChatGPT trial ends Thu — S$28/mo after. Keep / Cancel".

### Behaviour
- **Monthly equivalent** for every item (yearly ÷ 12, weekly × 52 ÷ 12). Totals: per month, per year, Essentials vs Lifestyle.
- **Annual renewals:** reminder 7 days before. In P, annual subscriptions get a monthly set-aside so the renewal isn't a surprise.
- **Price-change alerts:** when a charge matches an active subscription and its SGD amount differs from the expected amount by more than `max(2%, S$0.50)` (allow ±3% extra for foreign-currency charges), flag it and send: "Netflix went from S$19.98 to S$22.98 (+S$36/year)." Actions: **Accept new price** (updates the expected amount) / **Review**.
- **Missing charge:** expected charge more than 7 days late → a quiet flag on the Subscriptions screen only (no push); it may have been cancelled.
- **Quarterly "Still using?" check** (one batched push per quarter, counted in the nudge limit): Keep / Cancel / Remind me later. Choosing Cancel records the intent and opens the service's cancel page if the catalogue has a URL. It doesn't cancel anything itself.
- **Cost in goal terms**, shown on each subscription: "S$22.98/mo = S$276/yr. Cancelling moves 'Japan trip' 3 weeks earlier." Compute this from G's projection by adding the monthly amount to that goal's pace.

### Data
```sql
subscriptions(id TEXT PK, name TEXT, catalogue_key TEXT NULL, amount_minor INTEGER, currency TEXT,
  cycle TEXT CHECK(cycle IN ('weekly','monthly','quarterly','yearly')), next_renewal TEXT,
  account_id TEXT NULL, category_id TEXT, source TEXT CHECK(source IN ('detected','manual','apple_receipt','email_receipt')),
  status TEXT CHECK(status IN ('active','trial','cancel_intended','cancelled')),
  trial_ends TEXT NULL, merchant_pattern TEXT NULL, last_charged TEXT NULL, created_at TEXT)
subscription_events(id TEXT PK, subscription_id TEXT FK, kind TEXT, -- 'charged','price_change','renewal_reminder','usage_check','cancelled'
  data_json TEXT, at TEXT)
```
If a `recurring` table already exists (from the original spec), migrate it into `subscriptions` or turn it into a view of it. Don't keep two tables.

### Done when (tests)
- Candidate detection; price-change threshold edge cases incl. FX tolerance; accepting a new price; the missing-charge flag.
- Monthly-equivalent maths.
- Matching an Apple receipt to an APPLE.COM/BILL transaction, using a synthetic fixture marked unverified.
- Trial reminder timing in SGT.
- Annual set-aside amount.
- Goal-impact calculation.
- Merging a detected candidate with a manual entry (no duplicates).

---

## P — Income & personalised plan

**Purpose:** David enters his income, and Okanary prescribes how much goes to fixed costs, goals and lifestyle so his goals stay on time. Then it watches whether he follows the plan.

### Income model (base + commission)
- **Base take-home**: monthly, set in Settings (net of CPF if CPF applies; label the field "take-home"). This is the **planning floor**: the monthly plan is built on base pay only.
- **Commission and bonus** are logged when received: from income transactions (the existing Income group) or a quick "Log commission" button. They are **never** used to raise the regular Lifestyle budget.
- **Commission split rule** (default, editable): when commission arrives, Okanary proposes a split. Example defaults: **70% to goals** (in priority order, filling behind goals first), **20% guilt-free spending** (a one-off amount added to this month's Lifestyle allowance), **10% buffer** (topping up the emergency fund if not full, otherwise to goals). The 20% guilt-free share is deliberate: a plan that leaves nothing for enjoyment tends to get abandoned. Each part becomes a pledge David confirms, using the pledge flow from G.

### Plan engine (`/packages/core/plan.ts`, deterministic, tested)
For each month, from base take-home income `I`:
1. **Fixed costs** `C_fixed` = active subscriptions (monthly equivalent, from S) + annual set-asides (S) + Essentials baseline (average of last 3 months of Essentials spend excluding subscriptions, from U's baseline logic). David can override individual lines, e.g. rent.
2. **Goal contributions** `C_goals` = Σ `PMT_req` over goals in priority order (from G).
3. **Lifestyle** `L = I − C_fixed − C_goals`.
4. If `L` ≥ a minimum Lifestyle floor (setting; default = 60% of his last-3-month Lifestyle average, so the plan stays realistic): the plan is **feasible**. The monthly Lifestyle budget = `L`, capped at his current average plus 10% so the plan doesn't encourage extra spending. Any amount above the cap is added to goals in priority order.
5. If not feasible, show **trade-off options**, computed rather than asserted. David picks one, or several combined:
   - Extend the lowest-priority goals' dates (show the new dates).
   - Lower Lifestyle to `L` (show the weekly allowance this implies).
   - Use expected commission: "Behind goals need S$X/month; covered if commission averages ≥ S$Y/month". This is only shown if there is ≥ 3 months of commission history.
6. Output percentages of take-home: fixed / goals / lifestyle. Compare them with reference splits **as context only**: 50/30/20 and the Singapore-adjusted 60/20/20. Show text like "Your plan: 48 / 30 / 22 (needs / savings / wants)." The reference splits are benchmarks, not targets.

### Integration
- **The plan's Lifestyle number becomes the monthly Lifestyle budget**, which feeds A's weekly allowance. When David accepts a plan, the budget is updated. Manual override is allowed; the plan screen then shows "manual".
- Plan goal contributions set each goal's "planned monthly". G shows planned vs actual pace.
- **Monthly check-in** (1st of month, combined with N's monthly summary): last month's plan vs actual for fixed, goals and lifestyle; the new month's plan; and any commission splits to confirm.

### UI
- **Plan tab**: income card (base, commission logged this month), a stacked bar of the split, a per-goal contribution list, trade-off cards when infeasible, assumptions (edit), and "Estimates, not financial advice".
- **Onboarding wizard** (first open of the Plan tab): base take-home → confirm detected subscriptions and fixed costs → create or confirm goals (emergency fund suggested) → see the plan → accept.

### Data
```sql
income_settings(id TEXT PK, base_takehome_minor INTEGER, currency TEXT, effective_from TEXT)
income_events(id TEXT PK, kind TEXT CHECK(kind IN ('commission','bonus','other')), amount_minor INTEGER,
  received_on TEXT, transaction_id TEXT NULL, split_json TEXT NULL, split_status TEXT)
plans(id TEXT PK, month TEXT, inputs_json TEXT, outputs_json TEXT, accepted INTEGER, accepted_at TEXT NULL)
```

### Done when (tests)
- Feasible plan.
- Infeasible plan with each trade-off option calculated correctly.
- The Lifestyle cap with the overflow going to goals.
- Commission split pledges created and goals filled in priority order.
- An accepted plan updates the monthly Lifestyle budget and therefore A's allowance.
- Annual set-asides included.
- Percentages adding up to 100% within rounding.

---

## Kickoff prompt (Claude Code, plan mode)

```
Read docs/feature-brief-v2.md, CLAUDE.md, okanary-spec.md, PROGRESS.md,
DECISIONS.md and the existing code. Report which parts of A, U, N, G, W, S, P
(or of the earlier behaviour brief) already exist. Then produce one
implementation plan in the order A → U → N → G → W → S → P, mapping each to
concrete migrations, /packages/core functions, API routes, cron jobs, UI
screens and tests in THIS codebase. Cover: data migration for anything already
built (one goals system, one subscriptions table); every integration point in
"How everything connects"; the API keys/secrets I must create; and any conflict
between the brief and the real code with your proposed resolution. Do not
write code yet.
```

## Running it

The full set is large. Run it as **two goals** in the same session, with a check in between:

**Batch 1: spending behaviour and net worth (A, U, N, G).** After you approve the plan, switch to auto mode and paste:

```
/goal Implement the approved plan for docs/feature-brief-v2.md features A, U, N and G, in that order, one commit per feature, pushing after each. Prove each in the transcript: `npm test` exits 0 in all workspaces, `npm run build` exits 0 for /web and /worker, new migrations apply to the local D1 database, and that feature's "Done when" tests exist and pass. Follow every rule in "Rules for Claude Code". Do not start W, S or P. Stop after 150 turns.
```

Then deploy Batch 1 and use it for a few days (allowance, "vs usual", net worth, goals). Tell Claude Code anything that feels off before Batch 2.

**Batch 2: want list, subscriptions and plan (W, S, P).**

```
/goal Implement the approved plan for docs/feature-brief-v2.md features W, S and P, in that order, one commit per feature, pushing after each, building on the existing A, U, N and G. Prove each in the transcript: `npm test` exits 0 in all workspaces, `npm run build` exits 0 for /web and /worker, new migrations apply to the local D1 database, and that feature's "Done when" tests exist and pass. Follow every rule in "Rules for Claude Code". Stop after 150 turns.
```

### What you (David) need to do
1. Before Batch 1 is deployed: create free API keys at Finnhub, Alpha Vantage and CoinGecko (Demo), then `wrangler secret put FINNHUB_API_KEY` (and the other two).
2. Before Batch 2: forward one Apple subscription receipt email to yourself, redact it, and add it to `fixtures/` for the Apple receipt parser.
3. After Batch 2: open the Plan tab and run the onboarding wizard.

---

### Sources behind the design choices
- Gneezy & Potters, *An Experiment on Risk Taking and Evaluation Periods* — https://rady.ucsd.edu/_files/faculty-research/uri-gneezy/risk-taking.pdf
- Benartzi & Thaler, *Myopic Loss Aversion and the Equity Premium Puzzle* — https://papers.ssrn.com/sol3/papers.cfm?abstract_id=227015
- Gargano & Rossi, *Goal Setting and Saving in the FinTech Era* — https://ideas.repec.org/a/bla/jfinan/v79y2024i3p1931-1976.html
- Schwab, saving for multiple goals by time horizon — https://www.schwab.com/learn/story/how-to-save-multiple-financial-goals
- Ramsey, budgeting on commission income — https://www.ramseysolutions.com/budgeting/how-to-budget-on-commission-income
- 50/30/20 in Singapore (take-home vs gross, 60/20/20, 6-month emergency fund) — https://mysam.sg/the-503020-budget-rule-does-it-actually-work-for-singapores-cost-of-living/
- Finnhub free tier — https://freeapi.watch/finnhub/
- Alpha Vantage limits — https://www.macroption.com/alpha-vantage-api-limits/
- CoinGecko API pricing (Demo plan) — https://www.coingecko.com/en/api/pricing
- yahoo-finance2 Workers support PR — https://github.com/gadicc/yahoo-finance2/pull/793
- Twelve Data pricing (international markets need paid plans) — https://twelvedata.com/pricing
- Apple: what apple.com/bill means — https://support.apple.com/en-asia/108092
- Subscription tracker approaches — https://www.cnbc.com/select/best-subscription-trackers/
- Soman & Cheema, *Earmarking and Partitioning* — https://www-2.rotman.utoronto.ca/facbios/file/earmarking-jmrPP.pdf
- D'Acunto, Rossi & Weber, *Crowdsourcing Peer Information to Change Spending Behavior* — https://www.aeaweb.org/conference/2020/preliminary/paper/2aeniTdS
- Olafsson & Pagel, *The Ostrich in Us* — https://www.arnaolafsson.com/uploads/2/3/7/5/23754531/checking_restat_final.pdf
- Grubb et al., UK alerts study (via Boston College) — https://www.bc.edu/content/bc-web/sites/bc-news/articles/2025/spring/study-shows-text-message-alerts-significantly-reduce-overdrafts.html
