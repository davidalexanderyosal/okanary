import { sgtDate } from "@okanary/core";

export interface TripRow { id: string; name: string; start_date: string | null; end_date: string | null; exclude_from_monthly: number; currency: string | null }

/** The trip covering this instant (SGT calendar date), most recently started first. Used to auto-tag transactions. */
export async function tripCovering(db: D1Database, instant: string | Date): Promise<TripRow | null> {
  const d = sgtDate(instant);
  return db
    .prepare("SELECT * FROM trips WHERE start_date IS NOT NULL AND start_date <= ?1 AND (end_date IS NULL OR end_date >= ?1) ORDER BY start_date DESC LIMIT 1")
    .bind(d)
    .first<TripRow>();
}
