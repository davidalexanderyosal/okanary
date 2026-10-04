import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import {
  BALANCE_STALE_DAYS, addDays, addMonths, balanceAgeDays, buildSnapshot, changeOverRange, daysInMonth, holdingDayMoveSgd, holdingGainSgd,
  isDecimal, isNegativeDecimal, normalizeDecimal, sgtDate, splitFlowsMarket,
  type Breakdown, type BreakdownHolding, type NwBalance, type NwSnapshotRow, type SnapshotValues,
} from "@okanary/core";
import type { AppEnv } from "../env";
import { cachedFx, loadCardLiabilities, loadSnapshotInputs, neededCurrencies, runNetworthJob } from "../networth-job";
import { getSetting, setSetting } from "../settings";
import { ulid } from "../util";

export const networth = new Hono<AppEnv>();

const ATTRIBUTION = "Crypto prices by CoinGecko";
const REFRESH_MIN_INTERVAL_MS = 5 * 60_000;

const validDate = (s: string) => { const t = new Date(`${s}T00:00:00Z`); return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s; };
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(validDate, "invalid date");
const flag = z.union([z.literal(0), z.literal(1), z.boolean()]).transform((v) => (v ? 1 : 0));
const currencyCode = z.string().regex(/^[A-Za-z]{3}$/).transform((s) => s.toUpperCase());
const bad = (c: Context<AppEnv>, error: unknown) => c.json({ error }, 400);

interface SnapRow { date: string; assets_sgd_minor: number; liabilities_sgd_minor: number; net_sgd_minor: number; breakdown_json: string; flows_sgd_minor: number; market_sgd_minor: number }
const headline = (r: SnapRow) => ({
  date: r.date, net: r.net_sgd_minor, assets: r.assets_sgd_minor, liabilities: r.liabilities_sgd_minor,
  classes: (JSON.parse(r.breakdown_json) as Breakdown).classes, flows: r.flows_sgd_minor, market: r.market_sgd_minor,
});

/** Same calendar day one month earlier, clamped to that month's length (31 Mar -> 28 Feb). */
function sameDayLastMonth(today: string): string {
  const prev = addMonths(today.slice(0, 7), -1);
  return `${prev}-${String(Math.min(Number(today.slice(8)), daysInMonth(prev))).padStart(2, "0")}`;
}

// ---------------------------------------------------------------- reading

networth.get("/networth", async (c) => {
  const db = c.env.DB;
  const now = c.var.deps.now();
  const today = sgtDate(now);

  const snaps = (await db.prepare("SELECT date, net_sgd_minor, flows_sgd_minor, market_sgd_minor FROM networth_snapshots ORDER BY date").all<NwSnapshotRow>()).results;
  const latestRow = await db.prepare("SELECT * FROM networth_snapshots ORDER BY date DESC LIMIT 1").first<SnapRow>();

  const inputs = await loadSnapshotInputs(db, today);
  const fx = await cachedFx(db, neededCurrencies(inputs, today));
  const cards = await loadCardLiabilities(db, now);

  // No snapshot yet: value everything live from cached quotes/FX (no fetching) so the screen isn't empty.
  let live: SnapshotValues | null = null;
  let latest: ReturnType<typeof headline> | null = null;
  let breakdown: Breakdown;
  let change: unknown = null;
  if (latestRow) {
    latest = headline(latestRow);
    breakdown = JSON.parse(latestRow.breakdown_json) as Breakdown;
    const prev = snaps.length > 1 ? snaps[snaps.length - 2]! : null;
    change = {
      month: changeOverRange(snaps, sameDayLastMonth(today), today),
      ytd: changeOverRange(snaps, `${Number(today.slice(0, 4)) - 1}-12-31`, today),
      day: { date: latestRow.date, flows: latestRow.flows_sgd_minor, market: latestRow.market_sgd_minor, change: prev ? latestRow.net_sgd_minor - prev.net_sgd_minor : 0 },
    };
  } else {
    live = buildSnapshot({ date: today, ...inputs, cards, fx });
    const { flows, market } = splitFlowsMarket(null, live);
    latest = { date: today, net: live.net, assets: live.assets, liabilities: live.liabilities, classes: live.breakdown.classes, flows, market };
    breakdown = live.breakdown;
    change = { month: null, ytd: null, day: null };
  }

  const balRows = (await db.prepare("SELECT * FROM nw_balances ORDER BY as_of DESC, id DESC").all<NwBalance>()).results;
  const accountRows = (await db.prepare("SELECT * FROM nw_accounts WHERE archived = 0 ORDER BY name, id").all<{ id: string }>()).results;
  const bdAccounts = new Map(breakdown.accounts.map((a) => [a.id, a]));
  const accounts = accountRows.map((a) => {
    const balance = balRows.find((b) => b.account_id === a.id && b.as_of <= today) ?? balRows.find((b) => b.account_id === a.id) ?? null;
    const bd = bdAccounts.get(a.id);
    const age = balanceAgeDays(balance?.as_of ?? null, today);
    return { ...a, balance, value_sgd: bd ? bd.balance_sgd + bd.holdings_sgd : null, age_days: age, needs_update: age != null && age > BALANCE_STALE_DAYS };
  });

  const bdHoldings = new Map<string, BreakdownHolding>(breakdown.holdings.map((h) => [h.id, h]));
  const holdingRows = (await db.prepare("SELECT h.* FROM holdings h JOIN nw_accounts a ON a.id = h.account_id WHERE a.archived = 0 ORDER BY h.asset_type, h.symbol, h.id").all<{ id: string; cost_basis_minor: number | null; cost_currency: string | null }>()).results;
  const holdings = holdingRows.map((h) => {
    const bh = bdHoldings.get(h.id);
    return {
      ...h,
      price_minor: bh?.price_minor ?? null, price_currency: bh?.price_currency ?? null, value_sgd: bh?.value_sgd ?? null,
      gain_sgd: bh ? holdingGainSgd(h, bh.value_sgd, fx) : null, day_move_sgd: bh ? holdingDayMoveSgd(bh) : null,
      stale: bh ? bh.stale : true, quote_date: bh?.quote_date ?? null,
    };
  });

  return c.json({
    today, latest, change, accounts, holdings, cards,
    last_refresh_at: await getSetting(db, "networth_last_run"),
    live: !latestRow,
    attribution: ATTRIBUTION,
  });
});

const historyQuery = z.object({ days: z.coerce.number().int().min(1).max(3650).default(365) });
networth.get("/networth/history", async (c) => {
  const q = historyQuery.safeParse(c.req.query());
  if (!q.success) return bad(c, "bad query");
  const from = addDays(sgtDate(c.var.deps.now()), -q.data.days);
  const rows = (await c.env.DB.prepare("SELECT * FROM networth_snapshots WHERE date >= ? ORDER BY date").bind(from).all<SnapRow>()).results;
  return c.json(rows.map(headline));
});

networth.post("/networth/refresh", async (c) => {
  const deps = c.var.deps;
  const now = deps.now();
  const last = await getSetting(c.env.DB, "networth_last_refresh");
  const lastMs = last ? Date.parse(last) : NaN;
  if (!Number.isNaN(lastMs) && now.getTime() - lastMs < REFRESH_MIN_INTERVAL_MS) {
    return c.json({ error: "refreshed a moment ago", retry_after_s: Math.ceil((REFRESH_MIN_INTERVAL_MS - (now.getTime() - lastMs)) / 1000) }, 429);
  }
  await setSetting(c.env.DB, "networth_last_refresh", now.toISOString());
  return c.json(await runNetworthJob(c.env, deps));
});

// ---------------------------------------------------------------- accounts

const accountSchema = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(["cash", "brokerage", "crypto", "manual_asset", "liability"]),
  institution: z.string().trim().max(60).nullable().optional(),
  currency: currencyCode.default("SGD"),
  include_in_networth: flag.default(1),
  archived: flag.default(0),
});
const getAccount = (c: Context<AppEnv>, id: string) => c.env.DB.prepare("SELECT * FROM nw_accounts WHERE id = ?").bind(id).first<Record<string, unknown>>();

networth.post("/nw/accounts", async (c) => {
  const p = accountSchema.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return bad(c, p.error.flatten());
  const d = p.data;
  const id = ulid(c.var.deps.now().getTime());
  await c.env.DB.prepare("INSERT INTO nw_accounts (id, name, kind, institution, currency, include_in_networth, archived) VALUES (?,?,?,?,?,?,?)")
    .bind(id, d.name, d.kind, d.institution ?? null, d.currency, d.include_in_networth, d.archived).run();
  return c.json(await getAccount(c, id), 201);
});

networth.patch("/nw/accounts/:id", async (c) => {
  const p = accountSchema.partial().safeParse(await c.req.json().catch(() => null));
  if (!p.success) return bad(c, p.error.flatten());
  const id = c.req.param("id");
  const cur = await getAccount(c, id);
  if (!cur) return c.json({ error: "not found" }, 404);
  const n = { ...cur, ...Object.fromEntries(Object.entries(p.data).filter(([, v]) => v !== undefined)) } as Record<string, unknown>;
  await c.env.DB.prepare("UPDATE nw_accounts SET name=?, kind=?, institution=?, currency=?, include_in_networth=?, archived=? WHERE id=?")
    .bind(n.name, n.kind, n.institution ?? null, n.currency, n.include_in_networth, n.archived, id).run();
  return c.json(await getAccount(c, id));
});

// ---------------------------------------------------------------- balances

const balanceSchema = z.object({
  amount_minor: z.number().int().safe(),
  currency: currencyCode.optional(),
  as_of: isoDate.optional(),
  note: z.string().trim().max(200).nullable().optional(),
  flow_minor: z.number().int().safe().nullable().optional(),
});

networth.post("/nw/accounts/:id/balances", async (c) => {
  const p = balanceSchema.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return bad(c, p.error.flatten());
  const acct = await getAccount(c, c.req.param("id"));
  if (!acct) return c.json({ error: "not found" }, 404);
  const d = p.data;
  const id = ulid(c.var.deps.now().getTime());
  await c.env.DB.prepare("INSERT INTO nw_balances (id, account_id, amount_minor, currency, as_of, note, flow_minor) VALUES (?,?,?,?,?,?,?)")
    .bind(id, acct.id, d.amount_minor, d.currency ?? acct.currency, d.as_of ?? sgtDate(c.var.deps.now()), d.note ?? null, d.flow_minor ?? null).run();
  return c.json(await c.env.DB.prepare("SELECT * FROM nw_balances WHERE id = ?").bind(id).first(), 201);
});

networth.delete("/nw/balances/:id", async (c) => {
  const r = await c.env.DB.prepare("DELETE FROM nw_balances WHERE id = ?").bind(c.req.param("id")).run();
  return r.meta.changes ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});

// ---------------------------------------------------------------- holdings

const holdingSchema = z.object({
  account_id: z.string().min(1),
  asset_type: z.enum(["us_equity", "crypto"]),
  symbol: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9.\-_]{0,39}$/),
  quantity: z.string().refine((s) => isDecimal(s) && !isNegativeDecimal(s), "quantity must be a plain decimal string >= 0 (no exponent)"),
  cost_basis_minor: z.number().int().safe().min(0).nullable().optional(),
  cost_currency: currencyCode.nullable().optional(),
  acquired_at: isoDate.nullable().optional(),
});
const getHolding = (c: Context<AppEnv>, id: string) => c.env.DB.prepare("SELECT * FROM holdings WHERE id = ?").bind(id).first<Record<string, unknown>>();
/** Tickers are uppercase, CoinGecko ids lowercase. */
const symbolFor = (assetType: string, symbol: string) => (assetType === "crypto" ? symbol.toLowerCase() : symbol.toUpperCase());

networth.post("/nw/holdings", async (c) => {
  const p = holdingSchema.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return bad(c, p.error.flatten());
  const d = p.data;
  if (!(await getAccount(c, d.account_id))) return c.json({ error: "account not found" }, 404);
  const id = ulid(c.var.deps.now().getTime());
  await c.env.DB.prepare("INSERT INTO holdings (id, account_id, asset_type, symbol, quantity, cost_basis_minor, cost_currency, acquired_at) VALUES (?,?,?,?,?,?,?,?)")
    .bind(id, d.account_id, d.asset_type, symbolFor(d.asset_type, d.symbol), normalizeDecimal(d.quantity), d.cost_basis_minor ?? null,
      d.cost_basis_minor != null ? d.cost_currency ?? "SGD" : null, d.acquired_at ?? null).run();
  return c.json(await getHolding(c, id), 201);
});

networth.patch("/nw/holdings/:id", async (c) => {
  const body = await c.req.json().catch(() => null);
  const p = holdingSchema.partial().safeParse(body);
  if (!p.success) return bad(c, p.error.flatten());
  const id = c.req.param("id");
  const cur = await getHolding(c, id);
  if (!cur) return c.json({ error: "not found" }, 404);
  const n = { ...cur, ...Object.fromEntries(Object.entries(p.data).filter(([, v]) => v !== undefined)) } as Record<string, unknown> & { asset_type: string; symbol: string; quantity: string; account_id: string };
  if (p.data.account_id && !(await getAccount(c, p.data.account_id))) return c.json({ error: "account not found" }, 404);
  const costBasis = (n.cost_basis_minor as number | null) ?? null;
  await c.env.DB.prepare("UPDATE holdings SET account_id=?, asset_type=?, symbol=?, quantity=?, cost_basis_minor=?, cost_currency=?, acquired_at=? WHERE id=?")
    .bind(n.account_id, n.asset_type, symbolFor(n.asset_type, n.symbol), normalizeDecimal(n.quantity), costBasis,
      costBasis != null ? (n.cost_currency as string | null) ?? "SGD" : null, (n.acquired_at as string | null) ?? null, id).run();
  return c.json(await getHolding(c, id));
});

networth.delete("/nw/holdings/:id", async (c) => {
  const r = await c.env.DB.prepare("DELETE FROM holdings WHERE id = ?").bind(c.req.param("id")).run();
  return r.meta.changes ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});

// ---------------------------------------------------------------- card statements marked paid

const paidSchema = z.object({ statement_date: isoDate });
async function creditCard(c: Context<AppEnv>) {
  return c.env.DB.prepare("SELECT id FROM accounts WHERE id = ? AND kind = 'credit'").bind(c.req.param("accountId")).first<{ id: string }>();
}

networth.post("/cards/:accountId/statement-paid", async (c) => {
  const p = paidSchema.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return bad(c, p.error.flatten());
  const card = await creditCard(c);
  if (!card) return c.json({ error: "card not found" }, 404);
  const paidAt = c.var.deps.now().toISOString();
  await c.env.DB.prepare("INSERT OR REPLACE INTO card_statement_paid (account_id, statement_date, paid_at) VALUES (?,?,?)").bind(card.id, p.data.statement_date, paidAt).run();
  return c.json({ account_id: card.id, statement_date: p.data.statement_date, paid_at: paidAt }, 201);
});

/** DELETE takes the statement date as JSON body or ?statement_date=. */
networth.delete("/cards/:accountId/statement-paid", async (c) => {
  const body = await c.req.json().catch(() => null);
  const p = paidSchema.safeParse(body ?? { statement_date: c.req.query("statement_date") });
  if (!p.success) return bad(c, p.error.flatten());
  const card = await creditCard(c);
  if (!card) return c.json({ error: "card not found" }, 404);
  await c.env.DB.prepare("DELETE FROM card_statement_paid WHERE account_id = ? AND statement_date = ?").bind(card.id, p.data.statement_date).run();
  return c.json({ ok: true });
});
