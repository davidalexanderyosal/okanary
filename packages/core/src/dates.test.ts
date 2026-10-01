import { describe, expect, it } from "vitest";
import { addMonths, dayRangeUtc, daysInMonth, monthProgress, monthRangeUtc, sameDayLastMonthCutoff, sgtDate, sgtLocalToUtc, sgtMonth, sgtParts, sgtWeekRangeUtc } from "./dates";

describe("SGT month boundaries", () => {
  it("23:30 SGT on the last day of the month belongs to that month", () => {
    // 2026-10-31 23:30 SGT == 2026-10-31T15:30Z
    expect(sgtMonth("2026-10-31T15:30:00Z")).toBe("2026-10");
    expect(sgtDate("2026-10-31T15:30:00Z")).toBe("2026-10-31");
  });
  it("00:30 SGT on the 1st belongs to the new month even though UTC is still the old one", () => {
    // 2026-11-01 00:30 SGT == 2026-10-31T16:30Z
    expect(sgtMonth("2026-10-31T16:30:00Z")).toBe("2026-11");
    expect(sgtDate("2026-10-31T16:30:00Z")).toBe("2026-11-01");
  });
  it("exact boundary instant: 16:00Z is the first instant of the next SGT month", () => {
    expect(sgtMonth("2026-10-31T15:59:59.999Z")).toBe("2026-10");
    expect(sgtMonth("2026-10-31T16:00:00.000Z")).toBe("2026-11");
  });
  it("year rollover", () => {
    expect(sgtMonth("2026-12-31T16:00:00Z")).toBe("2027-01");
    expect(monthRangeUtc("2026-12")).toEqual({ start: "2026-11-30T16:00:00.000Z", end: "2026-12-31T16:00:00.000Z" });
  });
  it("monthRangeUtc is [start,end) in UTC", () => {
    expect(monthRangeUtc("2026-10")).toEqual({ start: "2026-09-30T16:00:00.000Z", end: "2026-10-31T16:00:00.000Z" });
  });
  it("matches Intl for Asia/Singapore across a sweep", () => {
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Singapore", year: "numeric", month: "2-digit", day: "2-digit" });
    for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 7 * 3600_000 + 13 * 60_000) {
      expect(sgtDate(t)).toBe(fmt.format(t));
    }
  });
});

describe("helpers", () => {
  it("daysInMonth incl. leap years", () => {
    expect(daysInMonth("2026-02")).toBe(28);
    expect(daysInMonth("2028-02")).toBe(29);
    expect(daysInMonth("2026-10")).toBe(31);
    expect(daysInMonth("2026-11")).toBe(30);
  });
  it("addMonths", () => {
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-05", -17)).toBe("2024-12");
  });
  it("dayRangeUtc / sgtLocalToUtc", () => {
    expect(dayRangeUtc("2026-10-01")).toEqual({ start: "2026-09-30T16:00:00.000Z", end: "2026-10-01T16:00:00.000Z" });
    expect(sgtLocalToUtc("2026-10-01", "08:15")).toBe("2026-10-01T00:15:00.000Z");
  });
  it("monthProgress uses SGT day", () => {
    // 2026-10-14 07:00 SGT
    expect(monthProgress("2026-10-13T23:00:00Z")).toEqual({ month: "2026-10", day: 14, daysInMonth: 31, daysLeft: 18 });
    // last day
    expect(monthProgress("2026-10-31T15:00:00Z").daysLeft).toBe(1);
  });
  it("sameDayLastMonthCutoff clamps (Mar 31 -> Feb 28)", () => {
    const c = sameDayLastMonthCutoff("2026-03-31T04:00:00Z");
    expect(c.start).toBe("2026-01-31T16:00:00.000Z");
    expect(c.end).toBe("2026-02-28T16:00:00.000Z");
  });
  it("week range is Monday-start in SGT", () => {
    // Wed 2026-09-30 SGT
    const w = sgtWeekRangeUtc("2026-09-30T04:00:00Z");
    expect(sgtDate(w.start)).toBe("2026-09-28");
    expect(sgtParts(w.start).hour).toBe(0);
    expect(sgtDate(new Date(Date.parse(w.end) - 1))).toBe("2026-10-04");
  });
});
