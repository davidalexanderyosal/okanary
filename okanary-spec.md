# Okanary — Personal Spend Tracker: Build Spec v1

> Name: **Okanary** — okane (お金, money) + canary: an early warning for your spending.
> Owner: David (single user). Handoff target: a Claude Code session.

---

## 1. Goal and the problem it solves

**Problem:** Almost all spending goes on credit cards (DBS, Citi). Card spend doesn't feel like money leaving, and the real total only shows up weeks later on the statement. There is no running view of "how much have I already spent on lifestyle this month".

**Goal:** Make the month-to-date spend, especially **lifestyle** spend, visible within minutes of each purchase, with as little manual typing as possible. The point is awareness that changes behaviour, not accounting.

**Design rules that follow from the goal**

1. **The home screen answers one question:** "How much have I spent this month, and am I ahead of or behind pace?" Everything else is one tap away.
2. **Capture must be close to zero effort.** Auto-capture first, then a 2-second "confirm category" step, then manual entry as a fallback.
3. **Lifestyle is a first-class bucket.** Every category belongs to a group: Essentials, Lifestyle, Savings/Investments, Income, Transfers (excluded). The Lifestyle total is always visible.
4. **Nudges at the moment of spending.** A push notification after a captured purchase shows the new lifestyle total ("Lifestyle: S$642 of S$900, day 14 of 31").
5. **Card cycle view as well as calendar month.** Show "spent on this DBS card since the last statement", which is what the next bill will be.

---

## 2. Platform reality (decided)

| Constraint | Implication |
|---|---|
| iPhone | iOS **does not let any app read other apps' notifications**. Reading DBS/Citi push notifications is impossible. Auto-capture must come from (a) the Apple Wallet transaction automation in Shortcuts and (b) bank alert **emails**. |
| Mostly Apple Pay taps | The Shortcuts **Wallet → Transaction** personal automation (iOS 17+) fires on contactless Apple Pay taps and provides **Amount, Merchant, Card name**. It can run "Get Contents of URL" (POST) without asking. This is the main real-time source. |
| Apple Pay trigger limits | Only fires for **in-store contactless taps**. Online, in-app and recurring charges are not captured. Known Apple bug: the trigger can time out, and it can fire on **declined** transactions. So email alerts are the backup and the confirming source. |
| DBS alerts | DBS sends card alerts by email, push and SMS. Default threshold is **S$500**, which must be lowered in digibank (App & Security Settings → Manage Notifications → Cards). Recurring charges (subscriptions, bills) do **not** trigger alerts. |
| Citi alerts | Citi sends card transaction alerts mainly by push in Citi Mobile; email support for every transaction is **unconfirmed**. Check "Manage alert preferences" in Citi Mobile. If per-transaction email isn't available, Citi online spend is covered only by manual entry and statement import (Phase 5). |
| Cloudflare + own domain | Use Cloudflare Pages + Workers + D1, plus **Email Routing → Email Worker** to receive alert emails at e.g. `spend@<domain>`. |
| Opens on the phone | Build an installable **PWA**. Web push works on iOS 16.4+ only when the PWA is **added to the Home Screen**. |
| Currencies | SGD base. Store original currency (IDR, JPY, anything) plus the SGD amount. |

Not available and out of scope: direct bank account linking (no Plaid-style aggregator for individuals in Singapore; SGFinDex is not open to personal apps).

---

## 3. Feature set

Features were picked from what established apps do (Copilot Money, Monarch, YNAB, Quicken Simplifi, NerdWallet, and Apple-Wallet-Shortcut trackers), **kept only if they serve awareness or control of spending.**

### 3.1 Must have (MVP, Phases 1–4)

| Feature | Why it serves the goal | Seen in |
|---|---|---|
| **Quick add** (amount → category → save in 3 taps; merchant and note optional) | Fallback capture must be fast or it won't happen | All |
| **Auto-capture: Apple Pay Shortcut** | Real-time capture of the main payment method | Wallet-Shortcut apps (CashJot, Finny) |
| **Auto-capture: bank alert emails** (DBS, Citi if possible) | Catches online and non-Apple-Pay spend | — |
| **Review inbox** ("To categorise" queue with one-tap category chips) | Auto-captured items need a quick confirm; reviewing is itself an awareness moment | Copilot "To review" |
| **Merchant rules that learn** ("Always put GRAB* → Transport?") | Over time most items are categorised automatically | Copilot, Monarch |
| **Category groups incl. Lifestyle** | Directly answers the pain point | NerdWallet 50/30/20 needs/wants |
| **Monthly budgets** per category and per group | The "control" part | YNAB, Monarch |
| **Pace indicator** (spent vs expected-by-today line) | "S$600 by day 14" means nothing without pace | Copilot, Simplifi |
| **Safe to spend today** for Lifestyle = (budget − spent) ÷ days left | Turns a monthly number into a daily decision | Simplifi "income after bills" (adapted) |
| **Post-purchase push** with updated Lifestyle total | Nudge at the moment of spending | — |
| **Threshold alerts** at 50 / 80 / 100% of a budget | Early warning | YNAB, Monarch |
| **Card-cycle view** (per card, since last statement date, plus due date) | Makes the next bill visible now | — |
| **Dashboard**: month total, Lifestyle vs budget, category donut/bars, daily spend bars with cumulative line, top merchants | Reporting | All |
| **Exclude / reimbursable flags** (card payments, transfers, work expenses claimed back) | Keeps totals honest | Simplifi "expected refunds" |
| **Multi-currency** with automatic SGD conversion | Trips to Indonesia and Japan | — |

### 3.2 Should have (Phase 5)

| Feature | Why |
|---|---|
| **Recurring / subscription detection** (same merchant ± amount monthly) and a "Subscriptions" screen with monthly total | Recurring charges don't trigger DBS alerts and are easy to forget |
| **Month-over-month and 6-month trends** per category/group | Shows whether behaviour is changing |
| **Weekly digest push** (Sunday evening: week total, Lifestyle vs pace, biggest 3 purchases) | Regular reflection |
| **Statement import & reconcile** (CSV if the bank provides it, else PDF text) to fill gaps and correct final SGD amounts after FX fees | Catches what auto-capture missed |
| **Trips/tags** (e.g. "Tokyo Dec 2026") so travel can be viewed or excluded separately | Travel shouldn't distort normal monthly views |
| **CSV export** | Data ownership |

### 3.3 Deliberately left out

~~Net worth, investment tracking~~ (added in v2, see §13), bill-pay reminders for non-card bills, shared/household budgets, gamified streaks, receipt OCR, and AI chat. They add build time without directly helping "see and control day-to-day spend". Can be revisited later.

---

## 4. Capture pipeline

```
 Apple Pay tap ──► iOS Shortcut (Wallet trigger) ──POST /api/ingest/applepay──┐
                                                                              │
 DBS/Citi alert email ─► Gmail filter auto-forward ─► spend@<domain>          ▼
                          (Cloudflare Email Routing) ─► Email Worker ──► ingest service
                                                                              │
 Manual quick add (PWA) ─────────────────────────────POST /api/transactions──┤
                                                                              ▼
                         raw_ingest (always stored) → parse → normalise merchant
                         → FX convert → dedupe/merge → categorise → save
                         → web push ("S$14.50 at Ya Kun · Lifestyle S$642/900")
```

### 4.1 Apple Pay Shortcut

- User creates: Shortcuts → Automation → **Wallet / Transaction** → choose DBS and Citi cards → **Run Immediately**.
- Action: **Get Contents of URL**, POST JSON to `https://<domain>/api/ingest/applepay`, header `Authorization: Bearer <INGEST_TOKEN>`, body `{ amount, merchant, card, ts: Current Date }`.
- The amount comes through as text with a currency symbol, so the server must parse the currency from it (`S$`, `Rp`, `¥`, `$`).
- The app ships a **Setup page** with the endpoint URL, token, and step-by-step screenshots/instructions so this can be redone on a new phone.
- Records from this source start as `status = pending` until confirmed by the matching email or 24 h pass (handles the "fires on declined" bug). Pending items still count in totals but are shown with a dotted style.

### 4.2 Email capture

- Cloudflare Email Routing: `spend@<domain>` → Email Worker (`email()` handler). Parse with `postal-mime`.
- Gmail: create filters for DBS and Citi alert senders → **forward to** `spend@<domain>`. Gmail's forwarding-verification email will arrive at the worker, so the worker must **forward any non-alert email to David's Gmail** (`message.forward()`) so he can click the verification link.
- Security: accept only allow-listed sender domains (dbs.com, citibank.com.sg, etc.) and check the `Authentication-Results` / DKIM pass header. Everything else is forwarded to Gmail, not parsed.
- **Per-bank parsers** (`parsers/dbs.ts`, `parsers/citi.ts`): regex extraction of amount, currency, merchant, card last 4, timestamp. Each parser has unit tests with **real redacted sample emails** in `fixtures/`.
- **Fallback:** if no regex matches, use Workers AI (small instruction model) to extract JSON `{amount, currency, merchant, card_last4, datetime}`; mark as `needs_review`.
- Nothing is ever dropped: unparseable emails stay in `raw_ingest` with `status = failed` and show in the Review inbox.

### 4.3 Dedup / merge

The same purchase can arrive from both Apple Pay and email. Match when:
same card, same currency, |amount difference| ≤ 1%, timestamps within 30 min, and merchant similarity (normalised token overlap) above a threshold.
On match, merge into one transaction: keep the email's amount (closer to the bank's record) and the Apple Pay timestamp, set `status = confirmed`, link both raw records. Possible but uncertain matches go to the Review inbox as "Possible duplicate — merge?".

### 4.4 Categorisation (in order)

1. **Merchant rule** (exact normalised merchant, then prefix/contains rules, e.g. `GRAB*`).
2. **History**: last category used for this normalised merchant.
3. **LLM suggestion** (Workers AI) from merchant name and the category list → saved as a suggestion, `needs_review = true`.
4. Otherwise uncategorised → Review inbox.

When the user changes a category, show "Always use **Transport** for **GRAB**?" → creates a rule.

Merchant normalisation: uppercase, strip trailing location/ID codes, payment-processor prefixes (`SQ *`, `GPAY*`, `PAYPAL *`, etc.), repeated spaces; keep `merchant_raw` too.

### 4.5 Currency

- Store `amount_minor` (integer, ISO 4217 minor units) + `currency` + `amount_sgd_minor` + `fx_rate` + `fx_source`.
- If the bank email states the SGD amount, use it (`fx_source = bank`). Else convert with a daily rate from a free ECB-based API (e.g. Frankfurter; it supports SGD, IDR, JPY), cached in `fx_rates` (`fx_source = ecb`). Statement import later overwrites with the final billed SGD.
- Never use floats for money.

---

## 5. Architecture

| Layer | Choice |
|---|---|
| Frontend | React + Vite + TypeScript + Tailwind, PWA (manifest, service worker via `vite-plugin-pwa`), Recharts for charts. Mobile-first, dark mode. |
| API | Cloudflare Workers with **Hono**, TypeScript. Same Worker serves `/api/*`; Pages serves the PWA (or Workers Static Assets — pick one, keep a single deploy). |
| DB | **Cloudflare D1** (SQLite). Migrations via `wrangler d1 migrations`. Drizzle ORM optional. |
| Email | Cloudflare Email Routing → Email Worker (same Worker, `email` export). |
| Scheduled jobs | Cron Triggers: hourly (promote stale pending items, FX refresh), daily 21:00 SGT (optional daily summary), weekly Sun 20:00 SGT (digest), daily recurring detection. |
| Push | Web Push (VAPID) from the Worker. Store subscriptions in D1. |
| AI | Workers AI for fallback parsing and category suggestions (cheap, no extra vendor). |
| Auth (single user) | **Cloudflare Access** (Zero Trust, free tier) in front of the app and `/api/*` with email OTP to David's email. **Exclude** `/api/ingest/applepay` from Access and protect it with a bearer `INGEST_TOKEN` (Worker secret, rotatable from Settings). The Email Worker is not HTTP-exposed. |
| Timezone | All "month", "day", "week" boundaries computed in **Asia/Singapore**. Store timestamps as UTC ISO strings. |

---

## 6. Data model (D1)

```sql
accounts(            -- cards / cash / e-wallets
  id TEXT PK, name TEXT, kind TEXT CHECK(kind IN ('credit','debit','cash','ewallet')),
  bank TEXT, last4 TEXT, wallet_card_name TEXT,     -- name as Apple Wallet reports it
  statement_day INTEGER, due_day INTEGER,           -- for card-cycle view
  currency TEXT DEFAULT 'SGD', archived INTEGER DEFAULT 0)

category_groups(id TEXT PK, name TEXT,            -- Essentials, Lifestyle, Savings, Income, Transfers
  counts_as_spend INTEGER, sort INTEGER)

categories(id TEXT PK, group_id TEXT FK, name TEXT, icon TEXT, color TEXT,
  sort INTEGER, archived INTEGER DEFAULT 0)

transactions(
  id TEXT PK, occurred_at TEXT, account_id TEXT FK NULL,
  amount_minor INTEGER, currency TEXT,
  amount_sgd_minor INTEGER, fx_rate REAL, fx_source TEXT,   -- 'same','bank','ecb','statement','manual'
  merchant_raw TEXT, merchant TEXT,                          -- normalised
  category_id TEXT FK NULL, category_source TEXT,            -- 'rule','history','ai','user'
  status TEXT CHECK(status IN ('pending','needs_review','confirmed','void')),
  source TEXT CHECK(source IN ('manual','applepay','email','import')),
  is_refund INTEGER DEFAULT 0, is_reimbursable INTEGER DEFAULT 0, is_excluded INTEGER DEFAULT 0,
  trip_id TEXT NULL, note TEXT, recurring_id TEXT NULL,
  created_at TEXT, updated_at TEXT)

raw_ingest(id TEXT PK, source TEXT, received_at TEXT, payload TEXT,   -- full email text / JSON
  parse_status TEXT, error TEXT, transaction_id TEXT NULL)

merchant_rules(id TEXT PK, match_type TEXT CHECK(match_type IN ('exact','prefix','contains','regex')),
  pattern TEXT, category_id TEXT, set_excluded INTEGER DEFAULT 0, priority INTEGER, hits INTEGER DEFAULT 0)

budgets(id TEXT PK, scope TEXT CHECK(scope IN ('group','category')), ref_id TEXT,
  monthly_amount_sgd_minor INTEGER, effective_from TEXT)          -- month 'YYYY-MM'

recurring(id TEXT PK, merchant TEXT, expected_amount_sgd_minor INTEGER, cadence TEXT,
  next_expected TEXT, category_id TEXT, active INTEGER, confirmed_by_user INTEGER)

trips(id TEXT PK, name TEXT, start_date TEXT, end_date TEXT, exclude_from_monthly INTEGER)

fx_rates(date TEXT, base TEXT, quote TEXT, rate REAL, PRIMARY KEY(date, base, quote))

push_subscriptions(id TEXT PK, endpoint TEXT UNIQUE, keys TEXT, created_at TEXT)

alert_log(id TEXT PK, kind TEXT, ref TEXT, period TEXT, sent_at TEXT)  -- prevents duplicate 80% alerts
settings(key TEXT PK, value TEXT)
```

Indexes: `transactions(occurred_at)`, `transactions(status)`, `transactions(merchant)`, `transactions(category_id, occurred_at)`.

**Spend definition** (one shared SQL view/function, used everywhere):
`status != 'void' AND is_excluded = 0 AND is_reimbursable = 0 AND group.counts_as_spend = 1`, refunds counted as negatives.

**Seed categories** (editable):
- Essentials: Groceries, Rent/Housing, Utilities & Phone, Transport (MRT/bus), Insurance, Health
- Lifestyle: Food & Drinks (eating out), Coffee/Snacks, Grab/Taxi, Shopping, Entertainment, Subscriptions, Travel, Personal care, Gifts, Hobbies
- Savings: Savings, Investments
- Income: Salary, Other income
- Transfers (excluded): Card payment, Own-account transfer

(Grab/Taxi sits in Lifestyle on purpose; it is usually a choice versus MRT. Change if wanted.)

---

## 7. Screens

1. **Home**
   - Big number: *Spent this month* (SGD), and the delta vs the same day last month.
   - **Lifestyle card**: spent / budget, progress bar with a pace marker, "Safe to spend today: S$xx".
   - Group mini-bars (Essentials, Lifestyle, Savings).
   - Review inbox badge ("4 to categorise").
   - Last 5 transactions.
   - Floating **+** button → Quick add.
2. **Quick add** (bottom sheet): numeric keypad first, currency switcher (defaults to last used; auto-suggest IDR/JPY if a trip is active), category chips (most-used first), optional merchant/note/account/date. Save in ≤ 3 taps.
3. **Review inbox**: cards with merchant, amount, source icon; one-tap category chips; swipe to mark excluded; "Possible duplicate" merge cards; failed-parse items with the raw text.
4. **Transactions**: list grouped by day, search, filters (month, group, category, account, source, trip), edit sheet.
5. **Dashboard / Reports**: month picker; category donut + ranked bars; daily spend bars with cumulative line vs budget pace line; top merchants; Lifestyle trend over 6 months; card-cycle tab per card ("DBS: S$1,240 since 12 Sep statement, due 7 Oct").
6. **Budgets**: per group and per category, copy last month, progress bars.
7. **Subscriptions** (Phase 5): detected recurring items, monthly total, confirm/dismiss.
8. **Settings**: accounts/cards (statement day, Wallet card name mapping), categories & groups, rules list, push on/off and alert thresholds, ingest token + Shortcut setup guide, email capture status (last email received per bank), export CSV, trips.

Push notifications:
- After each auto-captured transaction (toggle): "S$14.50 · Ya Kun · Coffee — Lifestyle S$642 / S$900 (day 14/31)". Tapping opens the item to change category.
- Budget thresholds at 50 / 80 / 100% (once per period per budget).
- Weekly digest (Phase 5).
- "Haven't heard from DBS emails in 3 days" health alert (helps catch broken forwarding).

---

## 8. Build phases

Each phase ends deployed and usable on the phone.

**Phase 0 — Skeleton (½ day)**
Monorepo (`/web`, `/worker`, shared `/packages/core` for money, dates, spend definition). Wrangler config, D1 created, first migration + seed, Hono health route, PWA shell installable on iPhone, Cloudflare Access in front. CI-free; `npm run deploy`.

**Phase 1 — Manual logging + basic dashboard (MVP that already helps)**
Accounts, categories/groups, Quick add, transactions list/edit/delete, Home with month total, Lifestyle total and group bars, simple category breakdown. SGD only to start but schema already multi-currency.
*Done when:* David can log a purchase in under 5 seconds from the Home Screen icon and see the Lifestyle total.

**Phase 2 — Apple Pay auto-capture + Review inbox + rules**
`/api/ingest/applepay` with token, amount/currency parsing, Wallet card name → account mapping, merchant normalisation, rules + history categorisation, Workers AI suggestion, Review inbox, "always categorise" prompt, Shortcut setup page, web push (VAPID) with post-purchase notification.
*Done when:* tapping Apple Pay at a café produces a push with the updated Lifestyle total within ~10 s, and the item is either auto-categorised or waiting in the inbox.

**Phase 3 — Email capture (DBS, then Citi) + dedup**
Email Worker, sender allow-list + DKIM check, forward-through for non-alerts, DBS parser with fixtures, Citi parser (if Citi emails exist), LLM fallback, raw_ingest viewer, Apple Pay ↔ email merge, pending → confirmed promotion cron, "no email in N days" health alert.
*Done when:* an online DBS card purchase appears in the app without any manual step, and an Apple Pay purchase isn't double-counted.

**Phase 4 — Budgets, pace and alerts**
Budgets screen, pace marker, safe-to-spend, threshold pushes with alert_log, card-cycle view, full dashboard charts, multi-currency (currency picker, FX table + cron, trip tagging basic).
*Done when:* the Home screen shows Lifestyle vs pace and a push arrives when Lifestyle crosses 80%.

**Phase 5 — Insight and accuracy**
Recurring detection + Subscriptions screen, MoM/6-month trends, weekly digest, statement import & reconcile (match by amount/date/merchant, add missing, correct SGD amounts), trips with exclude-from-monthly, CSV export.

---

## 9. Testing and quality bar

- Unit tests (Vitest): money math, currency parsing from Shortcut strings (`S$12.50`, `Rp 45.000`, `¥1,200`, `$8.90`), merchant normalisation, each bank parser against fixtures, dedup matcher, spend definition, SGT month boundaries (purchases at 23:30 on the last day of the month), pace / safe-to-spend math.
- Integration: Miniflare/wrangler dev tests for ingest endpoints and the email handler with fixture `.eml` files.
- Manual checklist per phase on the real iPhone (Home Screen install, push permission, Shortcut run).
- Never log full email bodies or tokens to console in production.

---

## 10. Things David needs to do (not code)

1. **Collect 3–5 real alert emails per bank** (DBS card alert, Citi if any; include a foreign-currency one if possible), redact card numbers/names, and save them as `.eml` or text into `worker/fixtures/`. Parsers can't be written reliably without them.
2. **DBS digibank:** lower the card alert threshold to the minimum allowed and enable **email** delivery.
3. **Citi Mobile:** check "Manage alert preferences" for per-transaction **email** alerts. Report back what's possible; this decides whether Citi gets a parser or relies on manual + statement import.
4. Confirm the domain is on Cloudflare and Email Routing can be enabled (MX records will be replaced, so use a domain that doesn't already receive email elsewhere, or a subdomain).
5. Set up the Gmail forwarding filter once the Email Worker is live (Phase 3).
6. Create the Shortcuts Wallet automation using the in-app setup page (Phase 2).
7. Decide monthly budgets for Lifestyle (and optionally per category) before Phase 4. A good first value is last month's actual, minus 10–15%.

---

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Apple Pay trigger times out / misses taps / fires on declines | Email backup, pending status, dedup, statement reconcile |
| Bank changes email format | Raw always stored, parser fixtures + tests, LLM fallback, "no parse" items in inbox, health alert |
| Recurring charges never alert | Recurring detection + statement import |
| Citi has no per-transaction email | Manual quick add + statement import; revisit later |
| Foreign-currency amount differs from billed SGD | Mark FX as estimate until bank/statement value arrives |
| iOS web push needs Home Screen install | Install prompt/instructions on first visit; app still works without push |
| Ingest endpoint abuse | Bearer token, rate limit, rotatable token, payload validation (zod) |

---

## 12. Claude Code kickoff prompt (Phase 0 + 1 only)

Paste this into a new Claude Code session together with this spec file:

```
You are building "Okanary", a single-user personal spend-tracker PWA. The full spec is in
okanary-spec.md — read all of it first, but implement ONLY Phase 0 and Phase 1 now.

Stack (fixed): React + Vite + TypeScript + Tailwind PWA (vite-plugin-pwa, Recharts),
Cloudflare Workers with Hono for /api, Cloudflare D1 with wrangler migrations,
single deploy. Monorepo: /web, /worker, /packages/core. Vitest for tests.

Rules:
- Money as integer minor units (ISO 4217); never floats. Timestamps in UTC; all
  month/day boundaries computed in Asia/Singapore.
- Implement the full D1 schema from section 6 in the first migration (even tables used
  in later phases) and seed the categories/groups from section 6.
- Put the "spend definition" in /packages/core and use it for every total.
- Mobile-first UI designed for iPhone in standalone PWA mode (safe-area insets,
  44px tap targets, dark mode). Home and Quick add from section 7 are the priority.
- Quick add must be achievable in 3 taps.
- Assume Cloudflare Access protects the app; do not build login. Leave
  /api/ingest/* unimplemented for now.
- Write unit tests for money math, SGT month boundaries and the spend definition.

Start by proposing the folder structure and the migration file, wait for my OK,
then build. At the end, give me exact commands to create the D1 database, run
migrations, deploy, and set up Cloudflare Access, plus how to add the PWA to
my iPhone Home Screen.
```

### Using `/goal` (after the structure is approved)

Once the folder structure and migration are agreed, set a goal for the rest of the phase. Example for Phase 0 + 1:

```
/goal Phase 0 and Phase 1 of okanary-spec.md are implemented. Prove it by showing in
the transcript: `npm test` exits 0 in every workspace; `npm run build` exits 0 for /web
and /worker; the D1 migrations apply successfully to the local database; and a local
`wrangler dev` run where creating a Lifestyle transaction through the API is then
returned by the month-summary endpoint inside the Lifestyle total.
Do not implement Phase 2+ features, do not deploy, and do not change the schema
in section 6 without asking. Stop after 40 turns.
```

Later phases follow the same pattern: "Phase N of okanary-spec.md is implemented", the *Done when* line rewritten as checks Claude can run, plus "do not start Phase N+1". Anything that needs the iPhone, the Cloudflare dashboard or real bank emails stays a manual check afterwards.

After Phase 1 is working, start the next session with: *"Read okanary-spec.md and the existing code. Implement Phase 2 only."* and so on per phase.

---

## 13. v2 features (docs/feature-brief-v2.md)

Built in the order A → U → N → G → W → S → P; mapping and conflicts in `docs/plan-v2.md`, decisions D-47 onward.

### 13.A Weekly Lifestyle allowance (built)
- Week = SGT, start day configurable (default Monday). Allowance = Σ over the months the week touches of `budget × days ÷ days_in_month` (cumulative rounding, exact month sums), or a fixed weekly override. Optional carry-over within a month (default off).
- Home Lifestyle card leads with "This week: S$X left of S$Y · resets Mon"; safe-to-spend today = (allowance − spent this week) ÷ days left in the week. Post-purchase push: "… — S$96 left this week".
- Weekly alerts at 80% and 100% of the allowance, once per week (`alert_log` period `YYYY-Www`); monthly budget alerts unchanged.
- Notification limit: max 2 nudge pushes per SGT day, quiet hours 23:00–08:00 (held, then sent); both configurable; post-purchase pushes exempt. Table `push_outbox`.

### 13.U "Vs your usual" (built)
- Month: spend to day d vs the average of days 1..min(d, length) over the last 3 complete months with data ("based on N months"; none → "Not enough history yet"). Week: first k days vs the last 4 complete weeks. Total, Lifestyle and each category (categories in Reports only); excluded trips left out; under ±5% = "about usual".
- Home: "S$640 so far · 12% below your usual by day 14" (amber only when above). Lifestyle card: "Week: about usual". Reports: per-category vs usual. Weekly digest: "Lifestyle this week S$210 · usual S$185". API `GET /api/usual`.

### 13.N Net worth (built)
- Assets: cash accounts (manual balance + as-of, any currency), US stocks/ETFs and crypto holdings (decimal-string quantities, optional cost basis), manual-value assets; liabilities: credit cards from the card-cycle data (since statement + last statement until paid) and optional manual loans.
- Prices: Finnhub → Alpha Vantage fallback, CoinGecko (SGD, attribution shown), FX via Frankfurter/fx_rates. Daily job 06:30 SGT writes price_quotes and one networth_snapshots row (idempotent); retries hourly to 12:00 SGT, then keeps the last price marked stale. "Refresh now" ≤ 1 per 5 minutes.
- Display: total, 1-month and YTD change split "You saved" vs "Market"; daily change one tap away on the Net worth screen only, never pushed. Home: "Net worth S$xx,xxx · +S$X this month". Monthly summary push on the 1st at 09:00 SGT. Balances older than 30 days get an "update?" chip.

### 13.G Goals (built)
- Goals of any horizon (short < 2 y, mid 2–10 y, long ≥ 10 y, derived from the date and refreshed daily); kinds emergency / short / mid / long / retirement; explicit priority (emergency first). Mid/long targets in today's dollars, inflated per goal (default 3%); retirement helper = monthly × 12 × 25; emergency fund suggestion = 6 × average monthly Essentials.
- Value from linked net-worth accounts/holdings (at a share) and earmarks, plus transferred contributions for goals without share links; pledges never count until transferred. Required monthly, current pace (market excluded), projected value/completion, On track / Ahead / Behind, ±2 pp range for long goals. "Move to safer funding?" once when a stock/crypto-funded goal drops below 2 years.
- Pledges: weekly underspend (Monday 00:00 SGT, to the receiving goal), skipped wants (W) and commission splits (P); Transferred / Skip in the app or from the push. Home: "Goals: 4 on track · 1 behind (MBA −S$120/mo)".

### 13.W Want list (built)
- "Want, not buy" (Quick add and Home) adds an item with a wait of 3 / 7 (default) / 30 days or custom; 30 by default above S$200. When the wait ends the item becomes Ready and one batched push asks "Still want AirPods case (S$59)? Buy / Skip" (counts toward the nudge limit).
- Skip → optional pledge of the price to the receiving goal; Buy → optional link to a matching transaction (±10%, 14 days); an early buy is recorded without comment. "Not bought this year: S$412 (9 items)" on Home and Reports.

### 13.S Subscriptions hub (built)
- One `subscriptions` table (Phase 5 `recurring` migrated in place). Ways in: detection (2 consecutive monthly charges ±15% → candidate + one push), manual add with a catalogue, Apple receipts (UNVERIFIED parser labels APPLE.COM/BILL charges), other receipts via AI → Review inbox, free trials (reminder 2 days before the end).
- Monthly/yearly equivalents and totals (Essentials vs Lifestyle); annual renewals get a reminder 7 days before and a monthly set-aside in the plan; price-change alerts (> max(2%, S$0.50), +3% for foreign currency) with Accept / Review; missing charge flag (> 7 days late, no push); quarterly "Still using?" batched push; cost in goal terms ("Cancelling moves 'Japan trip' 3 weeks earlier"). Okanary records the intent to cancel and opens the service's page; it never cancels anything.

### 13.P Income & personalised plan (built)
- Base take-home (Settings/Plan) is the planning floor; commission and bonuses are logged when received and never raise the regular Lifestyle budget. Commission split (default 70% goals in priority order, behind first / 20% guilt-free added to this week's allowance / 10% buffer to the emergency fund) becomes pledges David confirms.
- Plan engine: fixed (subscriptions + annual set-asides + Essentials baseline, overridable) + goals (Σ required, priority order) + Lifestyle (the rest, floor 60% / cap +10% of the usual, excess to goals). Infeasible → computed trade-offs (push back goal dates, lower Lifestyle with the weekly figure, commission coverage with ≥ 3 months of history). Percentages vs 50/30/20 and 60/20/20 as context only.
- Accepting a plan sets the monthly Lifestyle budget (→ A's weekly allowance) and each goal's planned monthly; manual budgets show as "manual". Monthly check-in with plan vs actual on the 1st. Onboarding wizard on first open.

## Sources

- [Apple Pay expense tracking with Shortcuts Wallet automation — CashJot](https://www.cashjot.com/blog/apple-pay-expense-tracking)
- [Apple Wallet expense tracker via Shortcuts, Get Contents of URL — TechTiff](https://techtiff.substack.com/p/apple-wallet-expense-tracker-shortcuts)
- [Shortcuts Transaction trigger timeouts / fires on declined — Apple Developer Forums](https://developer.apple.com/forums/thread/765516)
- [DBS notification alerts (channels, S$500 default, recurring excluded)](https://www.dbs.com.sg/personal/support/bank-ibanking-notification-alerts.html)
- [Citi Singapore push notifications](https://www.citibank.com.sg/personal-banking/online-services/push-notifications)
- [Cloudflare Email Workers docs](https://developers.cloudflare.com/email-routing/email-workers/)
- [postal-mime on Cloudflare Workers](https://postal-mime.postalsys.com/docs/guides/cloudflare-workers/)
- [PWA iOS limitations and web push (iOS 16.4+, Home Screen only) — MagicBell](https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide)
- [Copilot Money review — The Penny Hoarder](https://www.thepennyhoarder.com/budgeting/budgeting-copilot-money-review/)
- [Best budgeting apps 2026 — Engadget](https://www.engadget.com/apps/best-budgeting-apps-120036303.html)
