-- Phase 3: "Possible duplicate — merge?" cards in the Review inbox (spec §4.3, §7.3).
-- Spec §6 has no place to record an uncertain Apple Pay <-> email match, so it gets its own table (see DECISIONS.md D-22).
CREATE TABLE duplicate_candidates (
  id TEXT PRIMARY KEY,
  txn_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,    -- the newly captured one
  other_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,  -- the existing one it might duplicate
  created_at TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0                                     -- 1 = merged or dismissed
);
CREATE INDEX idx_dupcand_open ON duplicate_candidates(resolved, created_at);
