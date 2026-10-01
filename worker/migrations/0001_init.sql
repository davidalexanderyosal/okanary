-- Okanary initial schema (spec section 6) + seed. Constraint-only additions are logged in DECISIONS.md (D-03).
PRAGMA foreign_keys = ON;

CREATE TABLE accounts (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('credit','debit','cash','ewallet')),
  bank TEXT, last4 TEXT, wallet_card_name TEXT,
  statement_day INTEGER, due_day INTEGER,
  currency TEXT NOT NULL DEFAULT 'SGD', archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE category_groups (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  counts_as_spend INTEGER NOT NULL, sort INTEGER NOT NULL
);

CREATE TABLE categories (
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES category_groups(id),
  name TEXT NOT NULL, icon TEXT, color TEXT,
  sort INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE trips (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, start_date TEXT, end_date TEXT,
  exclude_from_monthly INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE recurring (
  id TEXT PRIMARY KEY, merchant TEXT NOT NULL, expected_amount_sgd_minor INTEGER,
  cadence TEXT, next_expected TEXT, category_id TEXT REFERENCES categories(id),
  active INTEGER NOT NULL DEFAULT 1, confirmed_by_user INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  account_id TEXT REFERENCES accounts(id),
  amount_minor INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'SGD',
  amount_sgd_minor INTEGER NOT NULL, fx_rate REAL,
  fx_source TEXT CHECK (fx_source IN ('same','bank','ecb','statement','manual')),
  merchant_raw TEXT, merchant TEXT,
  category_id TEXT REFERENCES categories(id),
  category_source TEXT CHECK (category_source IN ('rule','history','ai','user')),
  status TEXT NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('pending','needs_review','confirmed','void')),
  source TEXT NOT NULL CHECK (source IN ('manual','applepay','email','import')),
  is_refund INTEGER NOT NULL DEFAULT 0, is_reimbursable INTEGER NOT NULL DEFAULT 0,
  is_excluded INTEGER NOT NULL DEFAULT 0,
  trip_id TEXT REFERENCES trips(id), note TEXT,
  recurring_id TEXT REFERENCES recurring(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK (amount_minor >= 0 AND amount_sgd_minor >= 0)
);
CREATE INDEX idx_txn_occurred ON transactions(occurred_at);
CREATE INDEX idx_txn_status   ON transactions(status);
CREATE INDEX idx_txn_merchant ON transactions(merchant);
CREATE INDEX idx_txn_cat_occ  ON transactions(category_id, occurred_at);

CREATE TABLE raw_ingest (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, received_at TEXT NOT NULL,
  payload TEXT, parse_status TEXT, error TEXT,
  transaction_id TEXT REFERENCES transactions(id)
);

CREATE TABLE merchant_rules (
  id TEXT PRIMARY KEY,
  match_type TEXT NOT NULL CHECK (match_type IN ('exact','prefix','contains','regex')),
  pattern TEXT NOT NULL, category_id TEXT REFERENCES categories(id),
  set_excluded INTEGER NOT NULL DEFAULT 0, priority INTEGER NOT NULL DEFAULT 0,
  hits INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE budgets (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK (scope IN ('group','category')),
  ref_id TEXT NOT NULL, monthly_amount_sgd_minor INTEGER NOT NULL,
  effective_from TEXT NOT NULL
);

CREATE TABLE fx_rates (
  date TEXT NOT NULL, base TEXT NOT NULL, quote TEXT NOT NULL, rate REAL NOT NULL,
  PRIMARY KEY (date, base, quote)
);

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY, endpoint TEXT NOT NULL UNIQUE, keys TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE alert_log (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, ref TEXT, period TEXT, sent_at TEXT NOT NULL
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);

-- Seed: groups (Savings/Income/Transfers do not count as spend, see D-01)
INSERT INTO category_groups (id, name, counts_as_spend, sort) VALUES
  ('essentials','Essentials',1,1), ('lifestyle','Lifestyle',1,2),
  ('savings','Savings',0,3), ('income','Income',0,4), ('transfers','Transfers',0,5);

INSERT INTO categories (id, group_id, name, sort) VALUES
  ('groceries','essentials','Groceries',1), ('rent','essentials','Rent/Housing',2),
  ('utilities','essentials','Utilities & Phone',3), ('transport','essentials','Transport (MRT/bus)',4),
  ('insurance','essentials','Insurance',5), ('health','essentials','Health',6),
  ('food','lifestyle','Food & Drinks',1), ('coffee','lifestyle','Coffee/Snacks',2),
  ('grab','lifestyle','Grab/Taxi',3), ('shopping','lifestyle','Shopping',4),
  ('entertainment','lifestyle','Entertainment',5), ('subscriptions','lifestyle','Subscriptions',6),
  ('travel','lifestyle','Travel',7), ('personal_care','lifestyle','Personal care',8),
  ('gifts','lifestyle','Gifts',9), ('hobbies','lifestyle','Hobbies',10),
  ('savings','savings','Savings',1), ('investments','savings','Investments',2),
  ('salary','income','Salary',1), ('other_income','income','Other income',2),
  ('card_payment','transfers','Card payment',1), ('own_transfer','transfers','Own-account transfer',2);

INSERT INTO settings (key, value) VALUES ('base_currency','SGD'), ('timezone','Asia/Singapore');
