import { describe, expect, it } from "vitest";
import { decideAfter, defaultWaitDays, dueForReady, readyBatchBody, skippedTotal, suggestTransactionMatch, transition, waitLeft } from "./wants";

describe("W: decide_after in SGT", () => {
  it("is 00:00 SGT on the SGT date added + wait days", () => {
    expect(decideAfter("2026-10-14T04:00:00Z", 7)).toBe("2026-10-20T16:00:00.000Z"); // added Wed 14 Oct 12:00 SGT → Wed 21 Oct 00:00 SGT
    // 23:30 SGT on 14 Oct is still the 14th in Singapore (15:30Z), 00:30 SGT on 15 Oct is the 15th (16:30Z the day before in UTC)
    expect(decideAfter("2026-10-14T15:30:00Z", 3)).toBe("2026-10-16T16:00:00.000Z");
    expect(decideAfter("2026-10-14T16:30:00Z", 3)).toBe("2026-10-17T16:00:00.000Z");
    expect(decideAfter("2026-12-30T04:00:00Z", 30)).toBe("2027-01-28T16:00:00.000Z");
  });
  it("defaults to 7 days, 30 days above S$200 (configurable)", () => {
    expect(defaultWaitDays(5_900)).toBe(7);
    expect(defaultWaitDays(20_000)).toBe(7);
    expect(defaultWaitDays(20_001)).toBe(30);
    expect(defaultWaitDays(15_000, 10_000)).toBe(30);
  });
  it("countdown", () => {
    expect(waitLeft("2026-10-20T16:00:00.000Z", "2026-10-14T04:00:00Z")).toEqual({ days: 6, hours: 12, due: false });
    expect(waitLeft("2026-10-20T16:00:00.000Z", "2026-10-20T16:00:00Z").due).toBe(true);
  });
});

describe("W: status transitions", () => {
  const w = { status: "waiting" as const, decide_after: "2026-10-20T16:00:00.000Z" };
  it("waiting → ready only once the wait is over", () => {
    expect(transition(w, "ready", "2026-10-20T15:59:00Z")).toEqual({ ok: false, error: "not_due" });
    expect(transition(w, "ready", "2026-10-20T16:00:00Z")).toEqual({ ok: true, status: "ready", bought_early: false });
    expect(dueForReady([w, { ...w, status: "ready" as const }], "2026-10-21T00:00:00Z")).toHaveLength(1);
  });
  it("buying early asks once and is recorded; skipping is always allowed", () => {
    expect(transition(w, "buy", "2026-10-15T00:00:00Z")).toEqual({ ok: false, error: "confirm_early" });
    expect(transition(w, "buy", "2026-10-15T00:00:00Z", { confirmEarly: true })).toEqual({ ok: true, status: "bought", bought_early: true });
    expect(transition(w, "skip", "2026-10-15T00:00:00Z")).toEqual({ ok: true, status: "skipped", bought_early: false });
    expect(transition({ ...w, status: "ready" }, "buy", "2026-10-22T00:00:00Z")).toEqual({ ok: true, status: "bought", bought_early: false });
  });
  it("bought and skipped are final", () => {
    expect(transition({ ...w, status: "bought" }, "skip", "2026-10-22T00:00:00Z")).toEqual({ ok: false, error: "final" });
    expect(transition({ ...w, status: "skipped" }, "buy", "2026-10-22T00:00:00Z", { confirmEarly: true })).toEqual({ ok: false, error: "final" });
  });
});

describe("W: batching, skipped total, transaction match", () => {
  it("batches ready items into one push", () => {
    expect(readyBatchBody([])).toBeNull();
    expect(readyBatchBody([{ name: "AirPods case", price_sgd_minor: 5_900 }])).toBe("Still want AirPods case (S$59)? Buy / Skip");
    expect(readyBatchBody([{ name: "AirPods case", price_sgd_minor: 5_900 }, { name: "Lamp", price_sgd_minor: 4_500 }])).toBe("Still want these? AirPods case (S$59), Lamp (S$45). Buy / Skip");
    expect(readyBatchBody([{ name: "A", price_sgd_minor: 1_000 }, { name: "B", price_sgd_minor: 2_000 }, { name: "C", price_sgd_minor: 3_000 }, { name: "D", price_sgd_minor: 450 }])).toBe("Still want these? A (S$10), B (S$20) and 2 more. Buy / Skip");
  });
  it("skipped total counts skipped items decided this SGT year", () => {
    const rows = [
      { status: "skipped" as const, price_sgd_minor: 5_900, decided_at: "2026-03-01T00:00:00Z" },
      { status: "skipped" as const, price_sgd_minor: 35_300, decided_at: "2026-10-01T00:00:00Z" },
      { status: "skipped" as const, price_sgd_minor: 1_000, decided_at: "2025-12-31T15:59:00Z" }, // 23:59 SGT 31 Dec 2025
      { status: "skipped" as const, price_sgd_minor: 2_000, decided_at: "2025-12-31T16:00:00Z" }, // 00:00 SGT 1 Jan 2026
      { status: "bought" as const, price_sgd_minor: 9_999, decided_at: "2026-10-01T00:00:00Z" },
    ];
    expect(skippedTotal(rows, 2026)).toEqual({ total: 43_200, count: 3 });
  });
  it("suggests transactions within ±10% and 14 days, closest first", () => {
    const want = { price_sgd_minor: 10_000, decided_at: "2026-10-14T04:00:00Z" };
    const t = (id: string, amt: number, at: string, is_refund = 0) => ({ id, amount_sgd_minor: amt, occurred_at: at, is_refund });
    const out = suggestTransactionMatch(want, [
      t("a", 10_900, "2026-10-15T00:00:00Z"), t("b", 10_000, "2026-10-20T00:00:00Z"), t("c", 11_100, "2026-10-14T05:00:00Z"),
      t("d", 10_000, "2026-10-29T00:00:00Z"), t("e", 9_000, "2026-10-01T00:00:00Z"), t("f", 10_000, "2026-10-14T04:00:00Z", 1),
    ]);
    expect(out.map((x) => x.id)).toEqual(["b", "a", "e"]);
  });
});
