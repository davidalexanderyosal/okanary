-- v2 feature G: goals, funding links, daily goal snapshots, pledges/contributions (docs/feature-brief-v2.md "G — Goals").
-- No earlier goals table exists in this codebase (phases 0-5 never built one), so there is no goals data to migrate.
CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  emoji TEXT,
  target_sgd_minor INTEGER NOT NULL DEFAULT 0,      -- target at the target date (inflated for mid/long), refreshed daily
  target_date TEXT,                                  -- SGT 'YYYY-MM-DD'
  receives_underspend INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  horizon TEXT CHECK (horizon IN ('short','mid','long')),   -- derived from target_date, refreshed daily (C19)
  priority INTEGER NOT NULL DEFAULT 0,               -- 1 = funded first
  target_today_minor INTEGER NOT NULL DEFAULT 0,     -- in today's dollars (= the fixed amount for short/emergency)
  inflation_bp INTEGER,
  return_bp INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('emergency','short','mid','long','retirement')),
  start_date TEXT,
  planned_monthly_minor INTEGER                      -- set when a plan (feature P) is accepted
);
-- Only one goal can receive underspend pledges at a time.
CREATE UNIQUE INDEX uq_goals_underspend ON goals(receives_underspend) WHERE receives_underspend = 1;

CREATE TABLE goal_funding (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('nw_account','holding','earmark')),
  source_id TEXT NOT NULL,      -- nw_accounts.id (nw_account, earmark) or holdings.id (holding)
  share_bp INTEGER,             -- 10000 = 100% (nw_account, holding)
  earmark_minor INTEGER         -- SGD amount set aside inside a cash account (earmark)
);
CREATE INDEX idx_goal_funding_goal ON goal_funding(goal_id);

CREATE TABLE goal_snapshots (
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  value_sgd_minor INTEGER NOT NULL,
  PRIMARY KEY (goal_id, date)
);

CREATE TABLE goal_contributions (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  period TEXT NOT NULL,         -- 'YYYY-Www', 'YYYY-MM' or 'manual'
  amount_sgd_minor INTEGER NOT NULL CHECK (amount_sgd_minor >= 0),
  source TEXT NOT NULL CHECK (source IN ('underspend','want_skipped','commission','manual')),
  status TEXT NOT NULL CHECK (status IN ('pledged','transferred','skipped')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX idx_goal_contrib_goal ON goal_contributions(goal_id, status);
-- The Monday underspend job is safe to run twice: one underspend pledge per week.
CREATE UNIQUE INDEX uq_goal_contrib_underspend ON goal_contributions(period) WHERE source = 'underspend';
