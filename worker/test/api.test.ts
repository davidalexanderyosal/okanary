import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { currentMonthSgt } from "../src/month";

const app = createApp();
const call = (path: string, init?: RequestInit) => app.request(path, init, env as never);
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });

beforeEach(async () => {
  await env.DB.exec("DELETE FROM transactions");
});

describe("API", () => {
  it("health", async () => {
    const r = await call("/api/health");
    expect(r.status).toBe(200);
    expect((await r.json<{ ok: boolean }>()).ok).toBe(true);
  });

  it("seeds groups and categories", async () => {
    const r = await (await call("/api/categories")).json<{ groups: { id: string; counts_as_spend: number }[]; categories: unknown[] }>();
    expect(r.groups.map((g) => g.id)).toEqual(["essentials", "lifestyle", "savings", "income", "transfers"]);
    expect(r.groups.find((g) => g.id === "transfers")!.counts_as_spend).toBe(0);
    expect(r.categories).toHaveLength(22);
  });

  it("a Lifestyle transaction shows up inside the month summary's Lifestyle total", async () => {
    const created = await call("/api/transactions", json("POST", { amount_minor: 1450, category_id: "coffee", merchant: "Ya Kun" }));
    expect(created.status).toBe(201);
    await call("/api/transactions", json("POST", { amount_minor: 5000, category_id: "groceries" }));
    await call("/api/transactions", json("POST", { amount_minor: 99900, category_id: "card_payment" })); // transfer: excluded
    await call("/api/transactions", json("POST", { amount_minor: 300, category_id: "food", is_refund: true })); // refund nets off
    const s = await (await call(`/api/summary?month=${currentMonthSgt()}`)).json<{ total: number; byGroup: { id: string; spent: number }[] }>();
    expect(s.byGroup.find((g) => g.id === "lifestyle")!.spent).toBe(1450 - 300);
    expect(s.byGroup.find((g) => g.id === "essentials")!.spent).toBe(5000);
    expect(s.total).toBe(1450 - 300 + 5000);
  });

  it("rejects floats and non-positive amounts", async () => {
    expect((await call("/api/transactions", json("POST", { amount_minor: 12.5 }))).status).toBe(400);
    expect((await call("/api/transactions", json("POST", { amount_minor: 0 }))).status).toBe(400);
  });

  it("non-SGD needs amount_sgd_minor (D-08)", async () => {
    expect((await call("/api/transactions", json("POST", { amount_minor: 1200, currency: "JPY" }))).status).toBe(400);
    const r = await call("/api/transactions", json("POST", { amount_minor: 1200, currency: "JPY", amount_sgd_minor: 1068 }));
    expect(r.status).toBe(201);
    expect((await r.json<{ fx_source: string }>()).fx_source).toBe("manual");
  });

  it("edit and delete", async () => {
    const t = await (await call("/api/transactions", json("POST", { amount_minor: 1000 }))).json<{ id: string }>();
    const p = await call(`/api/transactions/${t.id}`, json("PATCH", { category_id: "food", amount_minor: 1100 }));
    const body = await p.json<{ amount_minor: number; amount_sgd_minor: number; category_source: string }>();
    expect(body.amount_minor).toBe(1100);
    expect(body.amount_sgd_minor).toBe(1100);
    expect(body.category_source).toBe("user");
    expect((await call(`/api/transactions/${t.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await call(`/api/transactions/${t.id}`)).status).toBe(404);
  });

  it("an SGT 23:30 purchase on the last day of last month stays out of this month", async () => {
    const m = currentMonthSgt();
    const [y, mo] = m.split("-").map(Number);
    const lastMonthEnd = new Date(Date.UTC(y!, mo! - 1, 1) - 8 * 3600_000 - 30 * 60_000).toISOString(); // 23:30 SGT last day
    await call("/api/transactions", json("POST", { amount_minor: 7777, category_id: "food", occurred_at: lastMonthEnd }));
    const s = await (await call(`/api/summary?month=${m}`)).json<{ total: number }>();
    expect(s.total).toBe(0);
  });

  it("unknown /api routes 404 and ingest is not implemented", async () => {
    expect((await call("/api/ingest/applepay", { method: "POST" })).status).toBe(404);
  });
});
