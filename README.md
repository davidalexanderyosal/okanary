# Okanary

Single-user personal spend tracker (PWA). See `okanary-spec.md` for the full spec, `PROGRESS.md` for build status
and `DECISIONS.md` for every judgement call.

```
packages/core   money (integer minor units), SGT dates, THE spend definition, month summary  (Vitest)
worker          Hono API on a Cloudflare Worker + D1 migrations                               (Vitest, workerd)
web             React + Vite + Tailwind PWA (vite-plugin-pwa, Recharts)                       (Vitest)
wrangler.jsonc  one Worker serving /api/* and the built PWA (Workers Static Assets)
```

## Local development (no Cloudflare account needed)

```bash
npm install
npm test                       # all workspaces
npm run build                  # web, then worker (wrangler dry-run)
npm run db:migrate:local       # applies worker/migrations to the local D1 (.wrangler/state)
npm run dev                    # builds web, serves everything on http://localhost:8787
# or: npx wrangler dev   +   npm run dev -w web   (Vite on :5173 proxies /api to :8787)
```

Never run `db:migrate:remote` or `deploy` unless you mean to; see the end-of-build summary / PROGRESS.md for the exact first-deploy steps.

## First deploy (you run these; nothing here was run for you)

Prereqs: a Cloudflare account with a domain on it (e.g. `example.com`), Node 20+, and this repo checked out.

```bash
npm install
npx wrangler login

# 1. D1 database. Copy the printed database_id into wrangler.jsonc ("d1_databases"[0].database_id)
npx wrangler d1 create okanary

# 2. Apply all migrations to the REMOTE db (0001 schema+seed, 0002 duplicate cards, 0003 trips.currency + alert uniqueness;
#    v2: 0004 push outbox, 0005 net worth, 0006 goals, 0007 wants, 0008 recurring -> subscriptions, 0009 income & plan)
npm run db:migrate:remote

# 3. Secrets. Web Push (VAPID) keys: run `npm run vapid`, then paste each value when prompted
npm run vapid
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT          # e.g. mailto:you@example.com
npx wrangler secret put FORWARD_TO             # your Gmail (a verified Email Routing destination, see below)
# v2 net worth prices (free keys; a missing key just skips that source):
npx wrangler secret put FINNHUB_API_KEY        # finnhub.io
npx wrangler secret put ALPHAVANTAGE_API_KEY   # alphavantage.co (fallback for US tickers)
npx wrangler secret put COINGECKO_API_KEY      # coingecko.com, Demo plan
# INGEST_TOKEN is optional: the Setup page can generate/rotate the Shortcut token for you. To bootstrap one yourself:
# npx wrangler secret put INGEST_TOKEN

# 4. Serve it on your domain: add to wrangler.jsonc, top level
#      "routes": [{ "pattern": "spend.example.com", "custom_domain": true }]
#    (or Workers & Pages -> okanary -> Settings -> Domains & Routes in the dashboard)

# 5. Build and deploy (builds the PWA, then `wrangler deploy`)
npm run deploy
```

### Cloudflare Access (login) in front of the app
Zero Trust dashboard -> **Access -> Applications -> Add an application -> Self-hosted**
1. **App 1: the whole site.** Domain `spend.example.com`, path empty. Identity provider: **One-time PIN**. Policy: *Allow*, Include -> **Emails** -> your email. Session duration: 1 month (so the Home Screen app rarely re-asks).
2. **App 2: the Shortcut endpoint.** Domain `spend.example.com`, path `/api/ingest/applepay`. Policy: action **Bypass**, Include -> **Everyone**. The more specific path wins; this endpoint is protected by the bearer token instead (Okanary Setup page).
3. Optional hard rate limit: **Security -> WAF -> Rate limiting rules**, match URI path `/api/ingest/applepay`, e.g. 30 requests / 1 minute -> Block.

### Email capture (Phase 3)
1. Dashboard -> your domain -> **Email -> Email Routing -> Enable** (this replaces the domain's MX records, so use a domain or subdomain that doesn't receive mail elsewhere).
2. **Destination addresses** -> add your Gmail and click the verification link. Use that address for `FORWARD_TO`.
3. **Routing rules -> Custom address** `spend@example.com` -> **Send to a Worker** -> `okanary`.
4. In Gmail: Settings -> Forwarding -> add `spend@example.com` (the confirmation mail is forwarded back to your Gmail by Okanary), then create a filter for the DBS/Citi alert senders -> *Forward it to* `spend@example.com`.
5. Check Okanary -> Settings -> Auto-capture -> "Bank alert emails": the first real email must show up there. If it is forwarded as "untrusted", see `worker/src/email-auth.ts` (DKIM check) and PROGRESS.md.

### iPhone: add to Home Screen
1. Open `https://spend.example.com` in **Safari** (not Chrome) and sign in with the Access one-time PIN.
2. Tap **Share** -> **Add to Home Screen** -> **Add**. Open Okanary from the new icon (it runs full screen, "standalone").
3. Sign in once more inside the app (Home Screen apps keep their own cookies).
4. **Settings -> Auto-capture & notifications -> Enable on this device** (needs iOS 16.4+ and the Home Screen app) and follow the on-screen Apple Pay Shortcut steps.

### Operational notes
- Workers **Free** plan allows ~50 D1 queries per request: a statement import of more than a few dozen lines may need the Paid plan, or split the file.
- `wrangler dev` / `npm run dev` use `wrangler.dev.jsonc` (no Workers AI binding, since that always talks to Cloudflare remotely); AI categorisation and the email AI fallback only work once deployed.

## Rules the code follows
- Money is an integer count of ISO 4217 minor units. Never floats (`packages/core/src/money.ts`).
- Timestamps are UTC ISO strings; every day/month boundary is computed in Asia/Singapore (`dates.ts`).
- Every total goes through the spend definition in `packages/core/src/spend.ts`.
- Cloudflare Access protects the app; there is no login code.
