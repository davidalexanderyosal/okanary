import { sgtDate } from "@okanary/core";

/**
 * SGD rate for 1 unit of `currency` on `date` (SGT 'YYYY-MM-DD'), from the fx_rates cache, else Frankfurter (ECB), else the
 * most recent cached rate. Returns null if nothing is known. (Spec §4.5; the daily refresh cron and picker UI come in Phase 4.)
 */
export async function getSgdRate(db: D1Database, currency: string, at: Date | string, doFetch: typeof fetch): Promise<{ rate: number; date: string } | null> {
  const cur = currency.toUpperCase();
  if (cur === "SGD") return { rate: 1, date: sgtDate(at) };
  const date = sgtDate(at);
  const hit = await db.prepare("SELECT rate FROM fx_rates WHERE date = ? AND base = ? AND quote = 'SGD'").bind(date, cur).first<{ rate: number }>();
  if (hit) return { rate: hit.rate, date };
  try {
    const res = await doFetch(`https://api.frankfurter.dev/v1/${date}?base=${cur}&symbols=SGD`, { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const j = (await res.json()) as { rates?: { SGD?: number } };
      const rate = j.rates?.SGD;
      if (typeof rate === "number" && rate > 0) {
        await db.prepare("INSERT OR REPLACE INTO fx_rates (date, base, quote, rate) VALUES (?, ?, 'SGD', ?)").bind(date, cur, rate).run();
        return { rate, date };
      }
    }
  } catch {
    /* fall through to last known */
  }
  const last = await db.prepare("SELECT rate, date FROM fx_rates WHERE base = ? AND quote = 'SGD' ORDER BY date DESC LIMIT 1").bind(cur).first<{ rate: number; date: string }>();
  return last ? { rate: last.rate, date: last.date } : null;
}
