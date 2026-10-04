import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  CATALOGUE, CYCLES, catalogueItem, convertMinor, findExistingSubscription, goalImpact, goalImpactText, isCharging, missingCharge, monthlyEquivalent, normalizeMerchant,
  renewalReminderDue, sgtDate, subscriptionTotals, trialReminderDue, yearlyEquivalent, type SubStatus,
} from "@okanary/core";
import type { AppEnv } from "../env";
import { getSgdRate } from "../fx";
import { loadGoals, type GoalView } from "../goals";
import { addSubscriptionEvent, getSubscription, linkTransactions, loadAllSubscriptions, runSubscriptionDetection, type SubRow } from "../subscriptions";
import { ulid } from "../util";

export const subscriptions = new Hono<AppEnv>();

const MAX = Number.MAX_SAFE_INTEGER;
const validDate = (s: string) => { const t = new Date(`${s}T00:00:00Z`); return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s; };
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(validDate, "invalid date");
const body = (c: Context<AppEnv>) => c.req.json().catch(() => null);
const notFound = (c: Context<AppEnv>) => c.json({ error: "not found" }, 404);

const fields = {
  name: z.string().trim().min(1).max(80),
  catalogue_key: z.string().max(40).nullable(),
  amount_minor: z.number().int().min(1).max(MAX),
  currency: z.string().length(3).transform((s) => s.toUpperCase()),
  expected_sgd_minor: z.number().int().min(1).max(MAX),
  cycle: z.enum(CYCLES as [string, ...string[]]),
  next_renewal: isoDate,
  account_id: z.string().min(1).max(64).nullable(),
  category_id: z.string().min(1).max(64).nullable(),
  merchant_pattern: z.string().trim().max(120).nullable(),
  trial_ends: isoDate.nullable(),
};
const createSchema = z.object({
  name: fields.name, catalogue_key: fields.catalogue_key.optional(), amount_minor: fields.amount_minor, currency: fields.currency.default("SGD"),
  expected_sgd_minor: fields.expected_sgd_minor.optional(), cycle: fields.cycle.optional(), next_renewal: fields.next_renewal,
  account_id: fields.account_id.optional(), category_id: fields.category_id.optional(), merchant_pattern: fields.merchant_pattern.optional(), trial_ends: fields.trial_ends.optional(),
  status: z.enum(["active", "trial", "cancel_intended", "cancelled"]).optional(),
});
const patchSchema = z.object({ ...fields, status: z.enum(["active", "trial", "cancel_intended", "cancelled"]) }).partial();

// ---------------------------------------------------------------- the view

interface GoalCtx { goal: GoalView | null }

/** The row plus derived numbers, flags and (for charging items) the cost in goal terms; old Phase 5 field names are kept for the current web page. */
function present(s: SubRow, now: Date, ctx: GoalCtx) {
  const today = sgtDate(now);
  const cycle = s.cycle;
  const monthly = monthlyEquivalent(s.expected_sgd_minor, cycle);
  let goal_impact: { goal_id: string; goal_name: string; weeks_earlier: number | null; reachable_only_if_cancelled: boolean; text: string } | null = null;
  if (ctx.goal && isCharging(s.status) && monthly > 0) {
    const g = ctx.goal;
    const impact = goalImpact(monthly, { target: g.target, value: g.value, pace: g.pace ?? 0, returnBp: g.return_bp });
    goal_impact = { goal_id: g.id, goal_name: g.name, weeks_earlier: impact.weeksEarlier, reachable_only_if_cancelled: impact.reachableOnlyIfCancelled, text: goalImpactText(s.name, monthly, g.name, impact) };
  }
  return {
    ...s,
    monthly_equivalent: monthly,
    yearly_equivalent: yearlyEquivalent(s.expected_sgd_minor, cycle),
    flags: {
      missing: missingCharge(s, today),
      price_change: s.pending_price_sgd_minor != null,
      trial_ending: s.status === "trial" && trialReminderDue(s.trial_ends, now),
      renewal_soon: renewalReminderDue(s, today),
    },
    cancel_url: catalogueItem(s.catalogue_key)?.cancel_url ?? null,
    goal_impact,
    // Phase 5 names (web/src/pages/Subscriptions.tsx until the hub page replaces it)
    merchant: s.merchant_pattern ?? s.name,
    expected_amount_sgd_minor: s.expected_sgd_minor,
    confirmed_by_user: s.status === "active" ? 1 : 0,
    active: s.status === "dismissed" || s.status === "cancelled" ? 0 : 1,
    next_expected: s.next_renewal,
  };
}

async function receivingGoal(c: Context<AppEnv>): Promise<GoalView | null> {
  try {
    const g = await loadGoals(c.env.DB, c.var.deps.now());
    return g.goals.find((x) => x.id === g.receiving_goal_id) ?? null;
  } catch {
    return null;
  }
}

const one = async (c: Context<AppEnv>, id: string, withGoal = false) => {
  const s = await getSubscription(c.env.DB, id);
  return s ? present(s, c.var.deps.now(), { goal: withGoal ? await receivingGoal(c) : null }) : null;
};

subscriptions.get("/subscriptions", async (c) => {
  const all = (await loadAllSubscriptions(c.env.DB)).filter((s) => s.status !== "dismissed");
  const totals = subscriptionTotals(all);
  const candidates = all.filter((s) => s.status === "candidate").reduce((a, s) => a + monthlyEquivalent(s.expected_sgd_minor, s.cycle), 0);
  const goal = all.some((s) => isCharging(s.status)) ? await receivingGoal(c) : null;
  const now = c.var.deps.now();
  return c.json({
    items: all.map((s) => present(s, now, { goal })),
    totals,
    confirmed_total: totals.monthly,
    monthly_total: totals.monthly + candidates,
    catalogue: CATALOGUE,
  });
});

subscriptions.post("/subscriptions/detect", async (c) => c.json(await runSubscriptionDetection(c.env, c.var.deps)));

// ---------------------------------------------------------------- manual add / edit

/** SGD value of a price: same currency, a given override, or the cached/ECB rate (null when unknown). */
async function toSgd(c: Context<AppEnv>, amountMinor: number, currency: string, override: number | undefined, at: Date): Promise<number | null> {
  if (override != null) return override;
  if (currency === "SGD") return amountMinor;
  const r = await getSgdRate(c.env.DB, currency, at, c.var.deps.fetch);
  return r ? convertMinor(amountMinor, currency, "SGD", r.rate) : null;
}

async function refsExist(c: Context<AppEnv>, accountId: string | null | undefined, categoryId: string | null | undefined): Promise<string | null> {
  if (accountId && !(await c.env.DB.prepare("SELECT 1 AS x FROM accounts WHERE id = ?").bind(accountId).first())) return "unknown account";
  if (categoryId && !(await c.env.DB.prepare("SELECT 1 AS x FROM categories WHERE id = ?").bind(categoryId).first())) return "unknown category";
  return null;
}

subscriptions.post("/subscriptions", async (c) => {
  const p = createSchema.safeParse(await body(c));
  if (!p.success) return c.json({ error: p.error.flatten() }, 400);
  const d = p.data;
  const now = c.var.deps.now();
  const cat = d.catalogue_key ? catalogueItem(d.catalogue_key) : null;
  if (d.catalogue_key && !cat) return c.json({ error: "unknown catalogue_key" }, 400);
  const status: SubStatus = d.status ?? (d.trial_ends ? "trial" : "active");
  if (status === "trial" && !d.trial_ends) return c.json({ error: "trial_ends is required for a trial" }, 400);
  const categoryId = d.category_id !== undefined ? d.category_id : (cat?.category_id ?? "subscriptions");
  const bad = await refsExist(c, d.account_id, categoryId);
  if (bad) return c.json({ error: bad }, 400);
  const sgd = await toSgd(c, d.amount_minor, d.currency, d.expected_sgd_minor, now);
  if (sgd == null) return c.json({ error: "fx rate unavailable: provide expected_sgd_minor" }, 422);
  const pattern = d.merchant_pattern !== undefined ? (d.merchant_pattern ? normalizeMerchant(d.merchant_pattern) : null) : (cat?.patterns[0] ? normalizeMerchant(cat.patterns[0]) : null);
  const cycle = d.cycle ?? cat?.cycle ?? "monthly";

  // a detected candidate / subscription for the same service is merged into this entry, never duplicated
  const detected = (await loadAllSubscriptions(c.env.DB)).filter((s) => s.source === "detected" && s.status !== "dismissed");
  const ex = findExistingSubscription(detected, { merchant: pattern ?? d.name, expected_sgd_minor: sgd });
  if (ex) {
    await c.env.DB.prepare(
      `UPDATE subscriptions SET name = ?, catalogue_key = ?, amount_minor = ?, currency = ?, expected_sgd_minor = ?, cycle = ?, next_renewal = ?, account_id = COALESCE(?, account_id),
         category_id = COALESCE(?, category_id), merchant_pattern = COALESCE(?, merchant_pattern), trial_ends = ?, status = ?, source = 'manual', pending_price_sgd_minor = NULL WHERE id = ?`,
    ).bind(d.name, d.catalogue_key ?? null, d.amount_minor, d.currency, sgd, cycle, d.next_renewal, d.account_id ?? null, categoryId, pattern, d.trial_ends ?? null, status, ex.id).run();
    await linkTransactions(c.env.DB, ex.id, pattern ?? ex.merchant_pattern);
    return c.json({ ...(await one(c, ex.id)), merged: true });
  }
  const id = ulid(now.getTime());
  await c.env.DB.prepare(
    `INSERT INTO subscriptions (id, name, catalogue_key, amount_minor, currency, cycle, next_renewal, account_id, category_id, source, status, trial_ends, merchant_pattern, expected_sgd_minor, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,'manual',?,?,?,?,?)`,
  ).bind(id, d.name, d.catalogue_key ?? null, d.amount_minor, d.currency, cycle, d.next_renewal, d.account_id ?? null, categoryId, status, d.trial_ends ?? null, pattern, sgd, now.toISOString()).run();
  await linkTransactions(c.env.DB, id, pattern);
  return c.json({ ...(await one(c, id)), merged: false }, 201);
});

subscriptions.patch("/subscriptions/:id", async (c) => {
  const id = c.req.param("id");
  const cur = await getSubscription(c.env.DB, id);
  if (!cur) return notFound(c);
  const p = patchSchema.safeParse(await body(c));
  if (!p.success) return c.json({ error: p.error.flatten() }, 400);
  const d = p.data;
  const next = { ...cur } as SubRow;
  const set = <K extends keyof SubRow>(k: K, v: SubRow[K] | undefined) => { if (v !== undefined) next[k] = v; };
  set("name", d.name); set("catalogue_key", d.catalogue_key); set("amount_minor", d.amount_minor); set("currency", d.currency); set("cycle", d.cycle as SubRow["cycle"]);
  set("next_renewal", d.next_renewal); set("account_id", d.account_id); set("category_id", d.category_id); set("trial_ends", d.trial_ends); set("status", d.status);
  if (d.merchant_pattern !== undefined) next.merchant_pattern = d.merchant_pattern ? normalizeMerchant(d.merchant_pattern) : null;
  if (d.catalogue_key && !catalogueItem(d.catalogue_key)) return c.json({ error: "unknown catalogue_key" }, 400);
  if (next.status === "trial" && !next.trial_ends) return c.json({ error: "trial_ends is required for a trial" }, 400);
  const bad = await refsExist(c, d.account_id, d.category_id);
  if (bad) return c.json({ error: bad }, 400);
  if (d.expected_sgd_minor !== undefined) next.expected_sgd_minor = d.expected_sgd_minor;
  else if (d.amount_minor !== undefined || d.currency !== undefined) {
    const sgd = await toSgd(c, next.amount_minor ?? 0, next.currency, undefined, c.var.deps.now());
    if (sgd == null) return c.json({ error: "fx rate unavailable: provide expected_sgd_minor" }, 422);
    next.expected_sgd_minor = sgd;
  }
  const priceEdited = d.expected_sgd_minor !== undefined || d.amount_minor !== undefined || d.currency !== undefined;
  await c.env.DB.prepare(
    `UPDATE subscriptions SET name=?, catalogue_key=?, amount_minor=?, currency=?, expected_sgd_minor=?, cycle=?, next_renewal=?, account_id=?, category_id=?, merchant_pattern=?, trial_ends=?, status=?,
       pending_price_sgd_minor = CASE WHEN ? THEN NULL ELSE pending_price_sgd_minor END WHERE id=?`,
  ).bind(next.name, next.catalogue_key, next.amount_minor, next.currency, next.expected_sgd_minor, next.cycle, next.next_renewal, next.account_id, next.category_id, next.merchant_pattern, next.trial_ends, next.status, priceEdited ? 1 : 0, id).run();
  if (next.status === "cancelled" && cur.status !== "cancelled") await addSubscriptionEvent(c.env.DB, id, "cancelled", { intent: false }, c.var.deps.now());
  if (next.merchant_pattern && next.merchant_pattern !== cur.merchant_pattern) await linkTransactions(c.env.DB, id, next.merchant_pattern);
  return c.json(await one(c, id));
});

// ---------------------------------------------------------------- actions

/** Runs `fn` for an existing subscription; 404 otherwise. */
async function act(c: Context<AppEnv>, fn: (s: SubRow, now: Date) => Promise<Record<string, unknown> | void>) {
  const s = await getSubscription(c.env.DB, c.req.param("id") ?? "");
  if (!s) return notFound(c);
  const extra = await fn(s, c.var.deps.now());
  return c.json({ ok: true, ...(extra ?? {}), item: await one(c, s.id) });
}

subscriptions.post("/subscriptions/:id/confirm", (c) => act(c, async (s) => {
  if (s.status === "candidate" || s.status === "dismissed") await c.env.DB.prepare("UPDATE subscriptions SET status = 'active' WHERE id = ?").bind(s.id).run();
  await linkTransactions(c.env.DB, s.id, s.merchant_pattern);
}));

subscriptions.post("/subscriptions/:id/dismiss", (c) => act(c, async (s) => {
  await c.env.DB.prepare("UPDATE subscriptions SET status = 'dismissed', pending_price_sgd_minor = NULL WHERE id = ?").bind(s.id).run();
  await c.env.DB.prepare("UPDATE transactions SET recurring_id = NULL WHERE recurring_id = ?").bind(s.id).run();
}));

subscriptions.post("/subscriptions/:id/accept-price", async (c) => {
  const s = await getSubscription(c.env.DB, c.req.param("id") ?? "");
  if (!s) return notFound(c);
  if (s.pending_price_sgd_minor == null) return c.json({ error: "no price change to accept" }, 400);
  const to = s.pending_price_sgd_minor;
  await c.env.DB.prepare("UPDATE subscriptions SET expected_sgd_minor = ?, amount_minor = CASE WHEN currency = 'SGD' THEN ? ELSE amount_minor END, pending_price_sgd_minor = NULL WHERE id = ?").bind(to, to, s.id).run();
  await addSubscriptionEvent(c.env.DB, s.id, "price_change", { accepted: true, from: s.expected_sgd_minor, to }, c.var.deps.now());
  return c.json({ ok: true, item: await one(c, s.id) });
});

subscriptions.post("/subscriptions/:id/review-price", (c) => act(c, async (s) => {
  await c.env.DB.prepare("UPDATE subscriptions SET pending_price_sgd_minor = NULL WHERE id = ?").bind(s.id).run(); // expected stays as it was
}));

subscriptions.post("/subscriptions/:id/cancel-intent", (c) => act(c, async (s, now) => {
  await c.env.DB.prepare("UPDATE subscriptions SET status = 'cancel_intended' WHERE id = ?").bind(s.id).run();
  await addSubscriptionEvent(c.env.DB, s.id, "cancelled", { intent: true }, now);
  return { cancel_url: catalogueItem(s.catalogue_key)?.cancel_url ?? null };
}));

subscriptions.post("/subscriptions/:id/cancelled", (c) => act(c, async (s, now) => {
  await c.env.DB.prepare("UPDATE subscriptions SET status = 'cancelled' WHERE id = ?").bind(s.id).run();
  await addSubscriptionEvent(c.env.DB, s.id, "cancelled", { intent: false }, now);
}));

subscriptions.post("/subscriptions/:id/keep", (c) => act(c, async (s, now) => {
  if (s.status === "trial" || s.status === "cancel_intended") await c.env.DB.prepare("UPDATE subscriptions SET status = 'active' WHERE id = ?").bind(s.id).run();
  await addSubscriptionEvent(c.env.DB, s.id, "usage_check", { answer: "keep" }, now);
}));

subscriptions.post("/subscriptions/:id/remind-later", (c) => act(c, async (s, now) => {
  await addSubscriptionEvent(c.env.DB, s.id, "usage_check", { answer: "later" }, now);
}));
