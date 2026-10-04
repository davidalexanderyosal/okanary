import { describe, expect, it } from "vitest";
import { categoriesVsUsual, compareToUsual, monthVsUsual, weekUsualLine, weekVsUsual, type UsualRow } from "./baseline";
import { sgtLocalToUtc } from "./dates";

let n = 0;
function row(date: string, amount: number, opts: Partial<UsualRow> & { time?: string } = {}): UsualRow {
  n++;
  return {
    occurred_at: sgtLocalToUtc(date, opts.time ?? "12:00"), amount_sgd_minor: amount, status: "confirmed",
    is_excluded: 0, is_reimbursable: 0, is_refund: 0, group_counts_as_spend: 1,
    group_id: "lifestyle", category_id: "food", trip_excluded: 0, ...opts,
  };
}
const NOW = "2026-10-14T04:00:00Z"; // Wed 14 Oct 2026, 12:00 SGT

describe("U: month baseline", () => {
  it("0 months of history → no usual ('Not enough history yet')", () => {
    const s = monthVsUsual([row("2026-10-02", 5000)], NOW);
    expect(s.periods).toEqual([]);
    expect(s.byKey.total).toEqual({ current: 5000, usual: null, comparison: { state: "no_history", diff: null, pct: null } });
  });
  it("1 month: only days 1..14 of September count", () => {
    const s = monthVsUsual([row("2026-09-03", 10000), row("2026-09-14", 2000, { time: "23:59" }), row("2026-09-15", 9999, { time: "00:00" }), row("2026-10-05", 6000)], NOW);
    expect(s.periods).toEqual(["2026-09"]);
    expect(s.day).toBe(14);
    expect(s.byKey.total!.usual).toBe(12000);
    expect(s.byKey.total!.comparison).toEqual({ state: "below", diff: -6000, pct: -50 });
  });
  it("2 months are averaged and reported as 'based on 2 months'", () => {
    const s = monthVsUsual([row("2026-08-10", 8000), row("2026-09-10", 12000), row("2026-10-10", 10000)], NOW);
    expect(s.periods).toEqual(["2026-09", "2026-08"]);
    expect(s.byKey.total!.usual).toBe(10000);
    expect(s.byKey.total!.comparison.state).toBe("about");
  });
  it("3+ months: the last 3 complete months that have data (an empty month is skipped)", () => {
    const rows = [row("2026-05-02", 1), row("2026-06-02", 3000), row("2026-07-02", 6000), row("2026-09-02", 9000), row("2026-10-02", 6000)];
    const s = monthVsUsual(rows, NOW); // August has no data
    expect(s.periods).toEqual(["2026-09", "2026-07", "2026-06"]);
    expect(s.byKey.total!.usual).toBe(6000);
  });
  it("day 31 against shorter months uses the whole shorter month", () => {
    const rows = [row("2026-09-30", 3000), row("2026-09-01", 1000), row("2026-10-31", 100)];
    expect(monthVsUsual(rows, "2026-10-31T04:00:00Z").byKey.total!.usual).toBe(4000);
    const feb = [row("2026-02-28", 2800, { time: "23:30" }), row("2026-03-31", 1)];
    const s = monthVsUsual(feb, "2026-03-31T04:00:00Z");
    expect(s.periods).toEqual(["2026-02"]);
    expect(s.byKey.total!.usual).toBe(2800);
  });
  it("excluded trips are left out of the current period and the baseline", () => {
    const rows = [
      row("2026-09-05", 10000), row("2026-09-06", 50000, { trip_excluded: 1 }),
      row("2026-08-05", 77777, { trip_excluded: 1 }), // a month with only trip spend has no data
      row("2026-10-05", 10000), row("2026-10-06", 40000, { trip_excluded: 1 }),
    ];
    const s = monthVsUsual(rows, NOW);
    expect(s.periods).toEqual(["2026-09"]);
    expect(s.byKey.total).toMatchObject({ current: 10000, usual: 10000 });
  });
  it("computes total, Lifestyle and each category; categories sort by largest increase", () => {
    const rows = [
      row("2026-09-05", 10000, { category_id: "food" }), row("2026-09-05", 5000, { category_id: "coffee" }), row("2026-09-05", 20000, { group_id: "essentials", category_id: "rent" }),
      row("2026-10-05", 16000, { category_id: "food" }), row("2026-10-05", 3000, { category_id: "coffee" }), row("2026-10-05", 20000, { group_id: "essentials", category_id: "rent" }),
    ];
    const s = monthVsUsual(rows, NOW);
    expect(s.byKey["group:lifestyle"]).toMatchObject({ current: 19000, usual: 15000, comparison: { state: "above", pct: 27 } });
    expect(categoriesVsUsual(s).map((c) => [c.id, c.comparison.diff])).toEqual([["food", 6000], ["rent", 0], ["coffee", -2000]]);
  });
});

describe("U: ±5% band", () => {
  it("strictly under 5% reads 'about usual'", () => {
    expect(compareToUsual(10400, 10000).state).toBe("about");
    expect(compareToUsual(9600, 10000).state).toBe("about");
    expect(compareToUsual(10500, 10000)).toEqual({ state: "above", diff: 500, pct: 5 });
    expect(compareToUsual(9500, 10000)).toEqual({ state: "below", diff: -500, pct: -5 });
    expect(compareToUsual(8800, 10000)).toEqual({ state: "below", diff: -1200, pct: -12 });
    expect(compareToUsual(0, 0).state).toBe("about");
    expect(compareToUsual(500, 0)).toEqual({ state: "above", diff: 500, pct: null });
    expect(compareToUsual(500, null).state).toBe("no_history");
  });
});

describe("U: week baseline", () => {
  it("first k days of the last 4 complete weeks with data (k = 3 on a Wednesday)", () => {
    const rows = [
      // current week Mon 12 Oct
      row("2026-10-12", 4000), row("2026-10-14", 1000),
      // previous weeks (Mon..Wed counted, Thu ignored)
      row("2026-10-05", 3000), row("2026-10-08", 99999),
      row("2026-09-28", 2000), row("2026-09-30", 1000, { time: "23:59" }),
      // week of 21 Sep has no data → skipped
      row("2026-09-14", 4000),
      row("2026-09-07", 2000),
      row("2026-08-31", 77777), // 5th week with data: not used
    ];
    const s = weekVsUsual(rows, NOW);
    expect(s.day).toBe(3);
    expect(s.periods).toEqual(["2026-10-05", "2026-09-28", "2026-09-14", "2026-09-07"]);
    expect(s.byKey.total!.current).toBe(5000);
    expect(s.byKey.total!.usual).toBe(3000); // (3000 + 3000 + 4000 + 2000) / 4
  });
  it("Sunday 23:59 SGT is the last moment of the week; works with a Sunday week start", () => {
    const rows = [row("2026-10-11", 2500, { time: "23:59" }), row("2026-10-04", 1000)];
    const s = weekVsUsual(rows, "2026-10-11T15:59:00Z");
    expect(s.day).toBe(7);
    expect(s.byKey.total).toMatchObject({ current: 2500, usual: 1000 });
    const sun = weekVsUsual(rows, "2026-10-11T15:59:00Z", 0); // week Sun 11 – Sat 17
    expect(sun.day).toBe(1);
    expect(sun.byKey.total!.current).toBe(2500);
  });
  it("no complete week with data → no history", () => {
    expect(weekVsUsual([row("2026-10-13", 100)], NOW).byKey.total!.comparison.state).toBe("no_history");
  });
  it("digest line", () => {
    expect(weekUsualLine(21000, 18500)).toBe("Lifestyle this week S$210 · usual S$185");
    expect(weekUsualLine(21000, null)).toBe("Lifestyle this week S$210");
  });
});
void n;
