-- Phase 4.
-- 1) Trips get a currency so Quick add can suggest it while a trip is active (spec §7.2: "auto-suggest IDR/JPY if a trip is active").
ALTER TABLE trips ADD COLUMN currency TEXT;
-- 2) Race-free "once per period" alerts: two concurrent captures must not both fire the same 80% alert (spec §6 alert_log).
CREATE UNIQUE INDEX uq_alert_log ON alert_log(kind, ref, period);
