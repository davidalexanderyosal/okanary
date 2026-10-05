-- v2 (feature A + notification rules): nudge pushes held for quiet hours or over the daily limit (docs/plan-v2.md §2.2).
-- Every push except post-purchase goes through worker/src/nudge-gate.ts; sent rows are also the per-day counter.
CREATE TABLE push_outbox (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                 -- e.g. 'budget', 'weekly_allowance', 'weekly_digest', 'email_health'
  tag TEXT,                           -- coalescing key: of several held rows with one tag only the newest is sent
  payload_json TEXT NOT NULL,         -- PushPayload {title, body, url, tag}
  created_at TEXT NOT NULL,
  send_after TEXT NOT NULL,           -- UTC ISO; = created_at when sent immediately
  sent_at TEXT,                       -- UTC ISO when delivered (NULL = still held)
  dropped INTEGER NOT NULL DEFAULT 0  -- 1 = superseded by a newer row with the same tag, or expired
);
CREATE INDEX idx_outbox_due ON push_outbox(sent_at, dropped, send_after);
CREATE INDEX idx_outbox_sent ON push_outbox(sent_at);
