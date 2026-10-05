import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { NOW, harness, resetDb } from "./helpers";

beforeEach(resetDb);

// NOW = Wed 14 Oct 2026 12:00 SGT: month day 14; week Mon 12 Oct (3rd day).
interface Result { current: number; usual: number | null; comparison: { state: string; diff: number | null; pct: number | null } }
interface Body {
  month: { day: number; periods: string[]; total: Result; lifestyle: Result; categories: ({ id: string } & Result)[] };
  week: { day: number; periods: string[]; total: Result; lifestyle: Result };
}
let seq = 0;
async function txn(minor: number, category: string, occurred_at: string, trip_id: string | null = null) {
  await env.DB.prepare("INSERT INTO transactions (id, occurred_at, amount_minor, currency, amount_sgd_minor, status, source, category_id, trip_id, created_at, updated_at) VALUES (?,?,?,?,?,'confirmed','manual',?,?,'x','x')")
    .bind(`u${++seq}`, occurred_at, minor, "SGD", minor, category, trip_id).run();
}
const get = async (now: Date = NOW) => (await harness({ now }).call("/api/usual")).json<Body>();

async function seed() {
  await env.DB.exec("INSERT INTO trips (id, name, start_date, end_date, exclude_from_monthly) VALUES ('tripx', 'Tokyo', '2026-09-04', '2026-09-06', 1)");
  // September (days 1..14 count)
  await txn(10000, "food", "2026-09-03T04:00:00Z");
  await txn(20000, "shopping", "2026-09-10T04:00:00Z");
  await txn(80000, "shopping", "2026-09-05T04:00:00Z", "tripx"); // excluded trip: not in the baseline
  await txn(50000, "food", "2026-09-20T04:00:00Z"); // after day 14: not in the baseline
  // August
  await txn(30000, "food", "2026-08-02T04:00:00Z");
  await txn(10000, "groceries", "2026-08-14T15:59:00Z"); // 14 Aug 23:59 SGT: in
  await txn(7777, "food", "2026-08-14T16:00:00Z"); // 15 Aug 00:00 SGT: out
  // July
  await txn(2000, "food", "2026-06-30T16:00:00Z"); // 1 Jul 00:00 SGT: in
  await txn(9999, "food", "2026-07-20T04:00:00Z"); // out
  // June: a fourth month is never used
  await txn(99999, "food", "2026-06-05T04:00:00Z");
  // October so far
  await txn(25000, "food", "2026-10-02T04:00:00Z");
  await txn(3000, "food", "2026-10-05T04:00:00Z"); // Mon 5 Oct
  await txn(5000, "groceries", "2026-10-05T04:00:00Z");
  await txn(1000, "coffee", "2026-10-07T04:00:00Z"); // Wed 7 Oct
  await txn(600, "coffee", "2026-10-13T04:00:00Z"); // Tue 13 Oct: this week
  await txn(99000, "shopping", "2026-10-10T04:00:00Z", "tripx"); // excluded trip: not in the current month either
}

describe("GET /api/usual: month", () => {
  it("averages the same point of the last 3 months with data, and excludes trips and later days", async () => {
    await seed();
    const { month } = await get();
    expect(month.day).toBe(14);
    expect(month.periods).toEqual(["2026-09", "2026-08", "2026-07"]); // June is the 4th: unused
    // usual = (Sep 30000 + Aug 40000 + Jul 2000) / 3; current = 25000 + 3000 + 5000 + 1000 + 600
    expect(month.total).toEqual({ current: 34600, usual: 24000, comparison: { state: "above", diff: 10600, pct: 44 } });
    // lifestyle usual = (30000 + 30000 + 2000) / 3 = 20666.67
    expect(month.lifestyle).toEqual({ current: 29600, usual: 20667, comparison: { state: "above", diff: 8933, pct: 43 } });
  });

  it("categories are sorted by largest increase, with zero-current categories last", async () => {
    await seed();
    const { month } = await get();
    expect(month.categories.map((c) => c.id)).toEqual(["food", "groceries", "coffee", "shopping"]);
    expect(month.categories[0]).toEqual({ id: "food", current: 28000, usual: 14000, comparison: { state: "above", diff: 14000, pct: 100 } });
    expect(month.categories[1]).toMatchObject({ id: "groceries", current: 5000, usual: 3333, comparison: { diff: 1667 } });
    expect(month.categories[2]).toMatchObject({ id: "coffee", current: 1600, usual: 0, comparison: { state: "above", diff: 1600, pct: null } });
    expect(month.categories[3]).toMatchObject({ id: "shopping", current: 0, usual: 6667, comparison: { state: "below", diff: -6667 } });
  });

  it("with no history there is nothing to compare with", async () => {
    const { month, week } = await get();
    expect(month.periods).toEqual([]);
    expect(month.total).toEqual({ current: 0, usual: null, comparison: { state: "no_history", diff: null, pct: null } });
    expect(month.lifestyle).toEqual({ current: 0, usual: null, comparison: { state: "no_history", diff: null, pct: null } });
    expect(month.categories).toEqual([]);
    expect(week.periods).toEqual([]);
    expect(week.lifestyle.comparison.state).toBe("no_history");
  });

  it("only this month's spend: still no history; one earlier month: based on 1 month", async () => {
    await txn(4000, "food", "2026-10-03T04:00:00Z");
    const first = await get();
    expect(first.month.total).toMatchObject({ current: 4000, usual: null, comparison: { state: "no_history" } });
    await txn(6000, "food", "2026-09-04T04:00:00Z");
    const second = await get();
    expect(second.month.periods).toEqual(["2026-09"]);
    expect(second.month.total).toMatchObject({ current: 4000, usual: 6000, comparison: { state: "below", diff: -2000, pct: -33 } });
  });

  it("a group with no spend defaults to zero (usual 0 with history), not a missing key", async () => {
    await txn(6000, "groceries", "2026-09-04T04:00:00Z"); // history exists, but nothing in Lifestyle
    const { month } = await get();
    expect(month.lifestyle).toEqual({ current: 0, usual: 0, comparison: { state: "about", diff: 0, pct: null } });
  });

  it("day 31 compares against whole shorter months", async () => {
    await txn(7000, "food", "2026-09-30T15:59:00Z"); // 30 Sep 23:59 SGT: the last day of a 30-day month
    await txn(1000, "food", "2026-10-30T04:00:00Z");
    const { month } = await get(new Date("2026-10-31T04:00:00Z"));
    expect(month.day).toBe(31);
    expect(month.total).toMatchObject({ current: 1000, usual: 7000 });
  });
});

describe("GET /api/usual: week", () => {
  it("compares the first days of this week with the last 4 complete weeks that have data", async () => {
    await seed();
    const { week } = await get();
    expect(week.day).toBe(3);
    // weeks of 5 Oct, 28 Sep, 14 Sep and 7 Sep have data; the week of 21 Sep is empty and skipped
    expect(week.periods).toEqual(["2026-10-05", "2026-09-28", "2026-09-14", "2026-09-07"]);
    // Mon-Wed of 5 Oct: food 3000 + coffee 1000 (+ groceries 5000 in the total); the other weeks have nothing in their first 3 days
    expect(week.lifestyle).toEqual({ current: 600, usual: 1000, comparison: { state: "below", diff: -400, pct: -40 } });
    expect(week.total).toMatchObject({ current: 600, usual: 2250 });
  });

  it("follows the week_start setting", async () => {
    await seed();
    await env.DB.exec("INSERT INTO settings (key, value) VALUES ('week_start', '0')");
    const { week } = await get();
    expect(week.day).toBe(4); // Sun 11 Oct is day 1
    expect(week.periods[0]).toBe("2026-10-04");
  });
});
