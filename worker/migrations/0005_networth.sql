-- v2 feature N: net worth (docs/feature-brief-v2.md "N — Net worth", docs/plan-v2.md §4 N).
-- Money in integer minor units; holdings quantities are decimal strings (packages/core/src/decimal.ts).
CREATE TABLE nw_accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('cash','brokerage','crypto','manual_asset','liability')),
  institution TEXT,
  currency TEXT NOT NULL DEFAULT 'SGD',
  include_in_networth INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0
);

-- History of manually entered balances/values (latest as_of wins). flow_minor (C7/D-54): for manual-value assets, the part
-- of the change since the previous entry that was David's own deposit/withdrawal; NULL = the whole change is flow.
CREATE TABLE nw_balances (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES nw_accounts(id) ON DELETE CASCADE,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  as_of TEXT NOT NULL,          -- SGT date 'YYYY-MM-DD'
  note TEXT,
  flow_minor INTEGER
);
CREATE INDEX idx_nw_balances_acct ON nw_balances(account_id, as_of);

CREATE TABLE holdings (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES nw_accounts(id) ON DELETE CASCADE,
  asset_type TEXT NOT NULL CHECK (asset_type IN ('us_equity','crypto')),
  symbol TEXT NOT NULL,         -- ticker (us_equity) or CoinGecko id (crypto)
  quantity TEXT NOT NULL,       -- decimal string, never a float
  cost_basis_minor INTEGER,
  cost_currency TEXT,
  acquired_at TEXT
);
CREATE INDEX idx_holdings_acct ON holdings(account_id);

CREATE TABLE price_quotes (
  symbol TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  date TEXT NOT NULL,           -- SGT date the price is for
  price_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  prev_close_minor INTEGER,
  source TEXT,
  stale INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (symbol, asset_type, date)
);

CREATE TABLE networth_snapshots (
  date TEXT PRIMARY KEY,        -- SGT date; one row per day, rewritten when the job runs again (idempotent)
  assets_sgd_minor INTEGER NOT NULL,
  liabilities_sgd_minor INTEGER NOT NULL,
  net_sgd_minor INTEGER NOT NULL,
  breakdown_json TEXT NOT NULL,
  flows_sgd_minor INTEGER NOT NULL DEFAULT 0,
  market_sgd_minor INTEGER NOT NULL DEFAULT 0
);

-- C8/D-55: "statement balance until it is marked paid" needs somewhere to record "paid".
CREATE TABLE card_statement_paid (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  statement_date TEXT NOT NULL,
  paid_at TEXT NOT NULL,
  PRIMARY KEY (account_id, statement_date)
);
