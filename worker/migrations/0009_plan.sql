-- v2 feature P: income and personalised plan (docs/feature-brief-v2.md "P — Income & personalised plan").
CREATE TABLE income_settings (
  id TEXT PRIMARY KEY,
  base_takehome_minor INTEGER NOT NULL CHECK (base_takehome_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'SGD',
  effective_from TEXT NOT NULL              -- 'YYYY-MM'; the latest row <= month applies
);

CREATE TABLE income_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('commission','bonus','other')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  received_on TEXT NOT NULL,                -- SGT 'YYYY-MM-DD'
  transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL,
  split_json TEXT,                          -- the proposed/confirmed split (core commissionSplit)
  split_status TEXT NOT NULL DEFAULT 'proposed' CHECK (split_status IN ('proposed','confirmed','skipped'))
);
CREATE UNIQUE INDEX uq_income_events_txn ON income_events(transaction_id) WHERE transaction_id IS NOT NULL;

CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  month TEXT NOT NULL,                      -- 'YYYY-MM'
  inputs_json TEXT NOT NULL,
  outputs_json TEXT NOT NULL,
  accepted INTEGER NOT NULL DEFAULT 0,
  accepted_at TEXT
);
CREATE INDEX idx_plans_month ON plans(month, accepted);

-- C15/D-67: one-off additions to a week's Lifestyle allowance (the commission split's guilt-free share).
CREATE TABLE lifestyle_bonus (
  id TEXT PRIMARY KEY,
  week_start TEXT NOT NULL,                 -- SGT date of the week's first day
  amount_sgd_minor INTEGER NOT NULL CHECK (amount_sgd_minor >= 0),
  source TEXT NOT NULL,                     -- e.g. 'commission:<income_event id>'
  created_at TEXT NOT NULL
);
CREATE INDEX idx_lifestyle_bonus_week ON lifestyle_bonus(week_start);
