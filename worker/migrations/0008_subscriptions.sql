-- v2 feature S: ONE subscriptions table (C1/C2, D-63). The Phase 5 `recurring` table is renamed in place, so its rows keep
-- their ids and transactions.recurring_id (FK) now points at subscriptions(id) (SQLite rewrites the FK on rename).
ALTER TABLE recurring RENAME TO subscriptions;
ALTER TABLE subscriptions RENAME COLUMN cadence TO cycle;
ALTER TABLE subscriptions RENAME COLUMN next_expected TO next_renewal;
ALTER TABLE subscriptions RENAME COLUMN expected_amount_sgd_minor TO expected_sgd_minor;  -- expected charge in SGD (price-change checks)

ALTER TABLE subscriptions ADD COLUMN name TEXT;
ALTER TABLE subscriptions ADD COLUMN catalogue_key TEXT;
ALTER TABLE subscriptions ADD COLUMN amount_minor INTEGER;               -- price in `currency`
ALTER TABLE subscriptions ADD COLUMN currency TEXT NOT NULL DEFAULT 'SGD';
ALTER TABLE subscriptions ADD COLUMN account_id TEXT REFERENCES accounts(id);
ALTER TABLE subscriptions ADD COLUMN source TEXT NOT NULL DEFAULT 'detected' CHECK (source IN ('detected','manual','apple_receipt','email_receipt'));
ALTER TABLE subscriptions ADD COLUMN status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','active','trial','cancel_intended','cancelled','dismissed'));
ALTER TABLE subscriptions ADD COLUMN trial_ends TEXT;
ALTER TABLE subscriptions ADD COLUMN merchant_pattern TEXT;
ALTER TABLE subscriptions ADD COLUMN last_charged TEXT;
ALTER TABLE subscriptions ADD COLUMN created_at TEXT;
ALTER TABLE subscriptions ADD COLUMN pending_price_sgd_minor INTEGER;    -- a flagged price change awaiting Accept / Review

-- Backfill from the Phase 5 columns: detected, SGD, monthly. Dismissed stays dismissed (never resurrected, D-40).
UPDATE subscriptions SET
  name = merchant,
  merchant_pattern = merchant,
  amount_minor = expected_sgd_minor,
  currency = 'SGD',
  cycle = COALESCE(cycle, 'monthly'),
  source = 'detected',
  status = CASE WHEN active = 0 THEN 'dismissed' WHEN confirmed_by_user = 1 THEN 'active' ELSE 'candidate' END,
  created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

ALTER TABLE subscriptions DROP COLUMN merchant;
ALTER TABLE subscriptions DROP COLUMN active;
ALTER TABLE subscriptions DROP COLUMN confirmed_by_user;
CREATE INDEX idx_subscriptions_pattern ON subscriptions(merchant_pattern);

CREATE TABLE subscription_events (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,           -- 'charged','price_change','renewal_reminder','trial_reminder','usage_check','cancelled','missing'
  data_json TEXT,
  at TEXT NOT NULL
);
CREATE INDEX idx_sub_events ON subscription_events(subscription_id, kind, at);
