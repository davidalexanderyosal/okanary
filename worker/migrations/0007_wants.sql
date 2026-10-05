-- v2 feature W: want list with a waiting timer (docs/feature-brief-v2.md "W — Want list").
CREATE TABLE wants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'SGD',
  price_sgd_minor INTEGER NOT NULL CHECK (price_sgd_minor >= 0),
  url TEXT,
  note TEXT,
  category_id TEXT REFERENCES categories(id),
  wait_days INTEGER NOT NULL,
  added_at TEXT NOT NULL,          -- UTC ISO
  decide_after TEXT NOT NULL,      -- UTC ISO: 00:00 SGT on (added SGT date + wait_days)
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','ready','bought','skipped')),
  decided_at TEXT,
  transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL,
  bought_early INTEGER NOT NULL DEFAULT 0   -- C16/D-62: bought before the wait ended (recorded, no shaming)
);
CREATE INDEX idx_wants_status ON wants(status, decide_after);
