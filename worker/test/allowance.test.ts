import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkWeeklyAllowanceAlerts } from "../src/alerts";
import { buildPurchaseNudgeBody } from "../src/capture";
import { emailHealthAlerts } from "../src/cron";
import { sendWeeklyDigest } from "../src/digest";
import { flushOutbox, sendNudge } from "../src/nudge-gate";
import { _resetRateLimit } from "../src/routes/ingest";
import { NOW, clientSubscription, count, genVapid, harness, json, resetDb } from "./helpers";

let vapid: { pub: string; priv: string };
beforeAll(async () => { vapid = await genVapid(); });
beforeEach(async () => { _resetRateLimit(); await resetDb(); });

type H = ReturnType<typeof harness>;
// Week of NOW (Wed 14 Oct 2026, 12:00 SGT): Mon 12 Oct – Sun 18 Oct, label 2026-W42. October has 31 days:
// allowance = round(90000·18/31) − round(90000·11/31) = 52258 − 31935 = 20323.
const WEEK_ALLOWANCE = 20323;
// Week of Mon 5 Oct: round(90000·11/31) − round(90000·4/31) = 31935 − 11613 = 20322.
const PREV_WEEK_ALLOWANCE = 20322;

const setBudget = (h: H, minor = 90000, month = "2026-10") => h.call("/api/budgets", json("PUT", { scope: "group", ref_id: "lifestyle", month, amount_sgd_minor: minor }));
let seq = 0;
/** Direct insert: no alert side effects. */
async function insertTxn(minor: number, category: string, occurred_at: string) {
  await env.DB.prepare("INSERT INTO transactions (id, occurred_at, amount_minor, currency, amount_sgd_minor, status, source, category_id, created_at, updated_at) VALUES (?,?,?,?,?,'confirmed','manual',?,'x','x')")
    .bind(`t${++seq}`, occurred_at, minor, "SGD", minor, category).run();
}
interface AllowanceBody {
  week: { startDate: string; endDate: string; day: number; daysLeft: number; label: string };
  allowance: { total: number; derived: number; base: number; overridden: boolean; carry: number; hasAllowance: boolean };
  spent: number;
  safe: { perDay: number; left: number; daysLeft: number; over: boolean };
  week_start: number; carry: boolean; override_minor: number | null;
  month: { budget: number | null; spent: number };
}
const getAllowance = async (h: H) => (await h.call("/api/allowance")).json<AllowanceBody>();
const at = (iso: string) => harness({ vapid, now: new Date(iso) });
const subscribe = async (h: H) => { expect((await h.call("/api/push/subscribe", json("POST", await clientSubscription()))).status).toBe(201); };

describe("GET /api/allowance", () => {
  it("derives the week from the Lifestyle budget and counts only Lifestyle spend inside the SGT week", async () => {
    const h = harness();
    await setBudget(h);
    await insertTxn(5000, "food", "2026-10-11T15:59:00Z"); // Sun 11 Oct 23:59 SGT: previous week
    await insertTxn(1200, "food", "2026-10-11T16:00:00Z"); // Mon 12 Oct 00:00 SGT: this week
    await insertTxn(3000, "coffee", "2026-10-14T03:00:00Z");
    await insertTxn(99900, "groceries", "2026-10-13T03:00:00Z"); // Essentials: not Lifestyle
    await insertTxn(70000, "food", "2026-10-18T16:00:00Z"); // Mon 19 Oct 00:00 SGT: next week
    const a = await getAllowance(h);
    expect(a.week).toEqual({ startDate: "2026-10-12", endDate: "2026-10-18", day: 3, daysLeft: 5, label: "2026-W42" });
    expect(a.allowance).toMatchObject({ total: WEEK_ALLOWANCE, derived: WEEK_ALLOWANCE, overridden: false, carry: 0, hasAllowance: true });
    expect(a.spent).toBe(4200);
    expect(a.safe).toEqual({ perDay: Math.floor((WEEK_ALLOWANCE - 4200) / 5), left: WEEK_ALLOWANCE - 4200, daysLeft: 5, over: false });
    expect(a).toMatchObject({ week_start: 1, carry: false, override_minor: null });
    expect(a.month).toEqual({ budget: 90000, spent: 5000 + 1200 + 3000 + 70000 });
  });

  it("without a Lifestyle budget there is no allowance", async () => {
    const a = await getAllowance(harness());
    expect(a.allowance).toMatchObject({ total: 0, hasAllowance: false });
    expect(a.month.budget).toBeNull();
    expect(a.safe.perDay).toBe(0);
  });

  it("a manual override replaces the derived value", async () => {
    const h = harness();
    await setBudget(h);
    await insertTxn(5000, "food", "2026-10-13T03:00:00Z");
    expect((await h.call("/api/settings", json("PUT", { allowance_override_minor: 15000 }))).status).toBe(200);
    const a = await getAllowance(h);
    expect(a.allowance).toMatchObject({ total: 15000, base: 15000, derived: WEEK_ALLOWANCE, overridden: true });
    expect(a.override_minor).toBe(15000);
    expect(a.safe.perDay).toBe(Math.floor(10000 / 5));
    await h.call("/api/settings", json("PUT", { allowance_override_minor: 0 })); // 0 removes it
    expect((await getAllowance(h)).allowance.total).toBe(WEEK_ALLOWANCE);
    expect(await count("SELECT COUNT(*) AS n FROM settings WHERE key = 'allowance_override_minor'")).toBe(0);
  });

  it("carry off: last week's spend is ignored; carry on: unspent/overspent rolls in, but never across a month start", async () => {
    const h = harness();
    await setBudget(h);
    await insertTxn(5000, "food", "2026-10-07T04:00:00Z"); // week of Mon 5 Oct: underspent by 20322 − 5000
    await insertTxn(90000, "food", "2026-09-30T04:00:00Z"); // week of Mon 28 Sep starts in September: no carry from it
    const off = await getAllowance(h);
    expect(off.allowance).toMatchObject({ total: WEEK_ALLOWANCE, carry: 0 });
    await h.call("/api/settings", json("PUT", { allowance_carry: true }));
    const on = await getAllowance(h);
    expect(on.carry).toBe(true);
    expect(on.allowance.carry).toBe(PREV_WEEK_ALLOWANCE - 5000);
    expect(on.allowance.total).toBe(WEEK_ALLOWANCE + PREV_WEEK_ALLOWANCE - 5000);
    // overspending last week reduces this week's allowance
    await insertTxn(30000, "food", "2026-10-08T04:00:00Z");
    expect((await getAllowance(h)).allowance.carry).toBe(PREV_WEEK_ALLOWANCE - 35000);
    // the first week starting in a month never inherits
    const first = harness({ now: new Date("2026-10-06T04:00:00Z") }); // Tue 6 Oct, week of 5 Oct
    expect((await getAllowance(first)).allowance.carry).toBe(0);
  });

  it("week_start moves the week (Sunday start: label is the ISO week of the first day)", async () => {
    const h = harness();
    await setBudget(h);
    await insertTxn(2500, "food", "2026-10-11T15:59:00Z"); // Sun 11 Oct 23:59 SGT: now inside the week
    await h.call("/api/settings", json("PUT", { week_start: 0 }));
    const a = await getAllowance(h);
    expect(a.week).toMatchObject({ startDate: "2026-10-11", endDate: "2026-10-17", day: 4, daysLeft: 4, label: "2026-W41" });
    expect(a.spent).toBe(2500);
  });
});

describe("settings API: allowance + notifications", () => {
  it("defaults, round trip and validation", async () => {
    const h = harness();
    const get = async () => h.call("/api/setup").then((r) => r.json<{ allowance_settings: unknown; notifications: unknown }>());
    expect(await get()).toMatchObject({
      allowance_settings: { week_start: 1, override_minor: null, carry: false },
      notifications: { daily_limit: 2, quiet_start: "23:00", quiet_end: "08:00" },
    });
    const put = (b: unknown) => h.call("/api/settings", json("PUT", b));
    expect((await put({ week_start: 6, allowance_override_minor: 12345, allowance_carry: true, nudge_daily_limit: 0, quiet_start: "22:30", quiet_end: "07:15" })).status).toBe(200);
    expect(await get()).toMatchObject({
      allowance_settings: { week_start: 6, override_minor: 12345, carry: true },
      notifications: { daily_limit: 0, quiet_start: "22:30", quiet_end: "07:15" },
    });
    await put({ allowance_override_minor: null });
    expect(((await get()).allowance_settings as { override_minor: number | null }).override_minor).toBeNull();
    for (const bad of [{ week_start: 7 }, { week_start: 1.5 }, { allowance_override_minor: -1 }, { nudge_daily_limit: 21 }, { quiet_start: "24:00" }, { quiet_end: "8:00" }, { quiet_start: "07:60" }]) {
      expect((await put(bad)).status).toBe(400);
    }
  });
});

describe("weekly allowance alerts (80% / 100%)", () => {
  const rows = () => env.DB.prepare("SELECT ref, period FROM alert_log WHERE kind = 'weekly_allowance' ORDER BY ref").all<{ ref: string; period: string }>().then((r) => r.results);

  it("crossing 80% writes one alert_log row (period 2026-W42) and one push; checking again adds nothing; 100% then adds one more", async () => {
    const h = harness({ vapid });
    await subscribe(h);
    await setBudget(h);
    await insertTxn(10000, "food", "2026-10-13T03:00:00Z"); // 49%
    await checkWeeklyAllowanceAlerts(h.e, h.deps);
    expect(await rows()).toEqual([]);

    await insertTxn(6300, "food", "2026-10-13T04:00:00Z"); // 16300 = 80.2%
    await checkWeeklyAllowanceAlerts(h.e, h.deps);
    expect(await rows()).toEqual([{ ref: "80", period: "2026-W42" }]);
    expect(h.pushes).toHaveLength(1);
    const body = (await env.DB.prepare("SELECT payload_json FROM push_outbox WHERE kind = 'weekly_allowance'").first<{ payload_json: string }>())!.payload_json;
    expect(JSON.parse(body)).toMatchObject({ body: "Lifestyle this week: 80% used, S$40 left of S$203. Resets Mon.", url: "/", tag: "weekly-allowance" });

    await checkWeeklyAllowanceAlerts(h.e, h.deps);
    await checkWeeklyAllowanceAlerts(h.e, h.deps);
    expect(await rows()).toEqual([{ ref: "80", period: "2026-W42" }]);
    expect(h.pushes).toHaveLength(1);

    await insertTxn(5000, "food", "2026-10-14T03:00:00Z"); // 21300 = 105%
    await checkWeeklyAllowanceAlerts(h.e, h.deps);
    expect((await rows()).map((r) => r.ref)).toEqual(["100", "80"]);
    expect(h.pushes).toHaveLength(2);
    const bodies = (await env.DB.prepare("SELECT payload_json FROM push_outbox WHERE kind = 'weekly_allowance'").all<{ payload_json: string }>()).results.map((r) => JSON.parse(r.payload_json).body as string);
    expect(bodies).toContain("Lifestyle this week: S$213 of S$203 used. A fresh week starts Mon.");
  });

  it("jumping straight past 100% logs both 80 and 100 but pushes once", async () => {
    const h = harness({ vapid });
    await subscribe(h);
    await setBudget(h);
    await insertTxn(25000, "food", "2026-10-13T03:00:00Z");
    await checkWeeklyAllowanceAlerts(h.e, h.deps);
    expect(await rows()).toEqual([{ ref: "100", period: "2026-W42" }, { ref: "80", period: "2026-W42" }]);
    expect(h.pushes).toHaveLength(1);
    await checkWeeklyAllowanceAlerts(h.e, h.deps);
    expect(h.pushes).toHaveLength(1);
  });

  it("a new week starts fresh; no allowance means no alerts", async () => {
    const h = harness();
    await insertTxn(99999, "food", "2026-10-13T03:00:00Z");
    await checkWeeklyAllowanceAlerts(h.e, h.deps); // no budget
    expect(await rows()).toEqual([]);
    await setBudget(h);
    await checkWeeklyAllowanceAlerts(h.e, h.deps);
    expect((await rows()).length).toBe(2);
    const next = harness({ now: new Date("2026-10-21T04:00:00Z") });
    await insertTxn(25000, "food", "2026-10-20T03:00:00Z");
    await checkWeeklyAllowanceAlerts(next.e, next.deps);
    expect((await rows()).map((r) => r.period).sort()).toEqual(["2026-W42", "2026-W42", "2026-W43", "2026-W43"]);
  });

  it("is triggered by a transaction write and goes through the gate", async () => {
    const h = harness({ vapid });
    await subscribe(h);
    await setBudget(h);
    await h.call("/api/transactions", json("POST", { amount_minor: 30000, category_id: "food", occurred_at: "2026-10-13T03:00:00Z" }));
    expect(await count("SELECT COUNT(*) AS n FROM alert_log WHERE kind = 'weekly_allowance'")).toBe(2);
    expect(await count("SELECT COUNT(*) AS n FROM push_outbox WHERE kind = 'weekly_allowance' AND sent_at IS NOT NULL")).toBe(1);
  });
});

describe("nudge gate", () => {
  const msg = (body: string, tag?: string) => ({ title: "Okanary", body, ...(tag ? { tag } : {}) });
  const outbox = () => env.DB.prepare("SELECT kind, tag, payload_json, send_after, sent_at, dropped FROM push_outbox ORDER BY created_at, id").all<{ kind: string; tag: string | null; payload_json: string; send_after: string; sent_at: string | null; dropped: number }>().then((r) => r.results);

  it("delivers up to the daily limit, then holds until 08:00 the next SGT day", async () => {
    const h = harness({ vapid });
    await subscribe(h);
    expect(await sendNudge(h.e, h.deps, msg("one", "a"), "budget")).toBe("sent");
    expect(await sendNudge(h.e, h.deps, msg("two", "b"), "budget")).toBe("sent");
    expect(await sendNudge(h.e, h.deps, msg("three", "c"), "budget")).toBe("held");
    expect(h.pushes).toHaveLength(2);
    const rows = await outbox();
    expect(rows).toHaveLength(3);
    const byTag = Object.fromEntries(rows.map((r) => [r.tag, r]));
    expect(byTag.a).toMatchObject({ sent_at: NOW.toISOString(), send_after: NOW.toISOString() });
    expect(byTag.b).toMatchObject({ sent_at: NOW.toISOString(), send_after: NOW.toISOString() });
    expect(byTag.c).toMatchObject({ kind: "budget", sent_at: null, send_after: "2026-10-15T00:00:00.000Z", dropped: 0 });
    expect(JSON.parse(byTag.c!.payload_json)).toEqual(msg("three", "c"));
  });

  it("the limit is configurable (0 holds everything)", async () => {
    const h = harness({ vapid });
    await subscribe(h);
    await h.call("/api/settings", json("PUT", { nudge_daily_limit: 0 }));
    expect(await sendNudge(h.e, h.deps, msg("x"), "budget")).toBe("held");
    expect(h.pushes).toHaveLength(0);
    expect((await outbox())[0]!.tag).toBeNull();
  });

  it("holds during quiet hours until 08:00", async () => {
    const h = at("2026-10-14T15:30:00Z"); // 23:30 SGT
    await subscribe(h);
    expect(await sendNudge(h.e, h.deps, msg("late"), "weekly_digest")).toBe("held");
    expect(h.pushes).toHaveLength(0);
    expect((await outbox())[0]).toMatchObject({ send_after: "2026-10-15T00:00:00.000Z", sent_at: null });
    const early = at("2026-10-14T20:00:00Z"); // 04:00 SGT next day: still quiet, same morning
    expect(await sendNudge(early.e, early.deps, msg("early"), "weekly_digest")).toBe("held");
    expect((await outbox())[1]!.send_after).toBe("2026-10-15T00:00:00.000Z");
  });

  it("the hourly flush at 08:00 delivers held rows within the limit and keeps the rest", async () => {
    const h = harness({ vapid });
    await subscribe(h);
    await h.call("/api/settings", json("PUT", { nudge_daily_limit: 0 }));
    for (const [i, tag] of ["a", "b", "c"].entries()) await sendNudge(at(`2026-10-14T04:0${i}:00Z`).e, at(`2026-10-14T04:0${i}:00Z`).deps, msg(`m-${tag}`, tag), "budget");
    await h.call("/api/settings", json("PUT", { nudge_daily_limit: 2 }));
    expect((await flushOutbox(h.e, h.deps))).toEqual({ sent: 0, dropped: 0 }); // 12:00 SGT: rows are not due until tomorrow
    const morning = at("2026-10-15T00:00:00Z");
    expect(await flushOutbox(morning.e, morning.deps)).toEqual({ sent: 2, dropped: 0 });
    expect(morning.pushes).toHaveLength(2);
    const rows = await outbox();
    expect(rows.map((r) => r.sent_at !== null)).toEqual([true, true, false]); // oldest first
    expect(rows[0]!.sent_at).toBe("2026-10-15T00:00:00.000Z");
    expect(rows[2]!.send_after).toBe("2026-10-16T00:00:00.000Z"); // limit reached: deferred to the next day
    expect(await flushOutbox(morning.e, morning.deps)).toEqual({ sent: 0, dropped: 0 });
  });

  it("held rows with the same tag deliver only the newest", async () => {
    const h = harness({ vapid });
    await subscribe(h);
    await h.call("/api/settings", json("PUT", { nudge_daily_limit: 0 }));
    const t1 = at("2026-10-14T04:00:00Z"), t2 = at("2026-10-14T04:05:00Z");
    await sendNudge(t1.e, t1.deps, msg("old", "weekly-allowance"), "weekly_allowance");
    await sendNudge(t2.e, t2.deps, msg("new", "weekly-allowance"), "weekly_allowance");
    await h.call("/api/settings", json("PUT", { nudge_daily_limit: 2 }));
    const morning = at("2026-10-15T00:00:00Z");
    expect(await flushOutbox(morning.e, morning.deps)).toEqual({ sent: 1, dropped: 1 });
    expect(morning.pushes).toHaveLength(1);
    const rows = await outbox();
    expect(rows.map((r) => [JSON.parse(r.payload_json).body, r.sent_at !== null, r.dropped])).toEqual([["old", false, 1], ["new", true, 0]]);
  });

  it("drops rows older than 72 hours instead of delivering them late", async () => {
    const h = harness({ vapid });
    await subscribe(h);
    await h.call("/api/settings", json("PUT", { nudge_daily_limit: 0 }));
    await sendNudge(h.e, h.deps, msg("stale", "s"), "budget"); // created 2026-10-14T04:00Z
    await h.call("/api/settings", json("PUT", { nudge_daily_limit: 2 }));
    const late = at("2026-10-17T04:00:01Z");
    expect(await flushOutbox(late.e, late.deps)).toEqual({ sent: 0, dropped: 1 });
    expect(late.pushes).toHaveLength(0);
    expect((await outbox())[0]).toMatchObject({ dropped: 1, sent_at: null });
  });

  it("digest and email-health pushes go through the gate (and honour it)", async () => {
    const h = harness({ vapid, now: new Date("2026-10-18T12:00:00Z") }); // Sun 20:00 SGT
    await subscribe(h);
    await sendWeeklyDigest(h.e, h.deps);
    expect(await count("SELECT COUNT(*) AS n FROM push_outbox WHERE kind = 'weekly_digest' AND sent_at IS NOT NULL")).toBe(1);
    await env.DB.prepare("INSERT INTO raw_ingest (id, source, received_at, parse_status) VALUES ('r1','email:dbs','2026-10-10T00:00:00Z','ok')").run();
    await h.call("/api/settings", json("PUT", { nudge_daily_limit: 1 }));
    expect(await emailHealthAlerts(h.e, h.deps)).toEqual(["dbs"]); // alert_log dedupe unchanged...
    expect(await count("SELECT COUNT(*) AS n FROM push_outbox WHERE kind = 'email_health' AND sent_at IS NULL")).toBe(1); // ...but over the limit: held
    expect(h.pushes).toHaveLength(1);
  });
});

describe("post-purchase push stays outside the gate", () => {
  const apple = (h: H) => h.call("/api/ingest/applepay", { method: "POST", headers: { authorization: "Bearer tok", "content-type": "application/json" }, body: JSON.stringify({ amount: "S$14.50", merchant: "Ya Kun" }) });

  it("is delivered after the daily limit is reached", async () => {
    const h = harness({ vapid });
    await subscribe(h);
    await sendNudge(h.e, h.deps, { title: "Okanary", body: "1" }, "budget");
    await sendNudge(h.e, h.deps, { title: "Okanary", body: "2" }, "budget");
    expect(h.pushes).toHaveLength(2);
    expect((await apple(h)).status).toBe(201);
    expect(h.pushes).toHaveLength(3);
    expect(await count("SELECT COUNT(*) AS n FROM push_outbox")).toBe(2); // the purchase push is not in the outbox / not counted
  });

  it("is delivered during quiet hours", async () => {
    const h = at("2026-10-14T15:30:00Z"); // 23:30 SGT
    await subscribe(h);
    expect((await apple(h)).status).toBe(201);
    expect(h.pushes).toHaveLength(1);
    expect(await count("SELECT COUNT(*) AS n FROM push_outbox")).toBe(0);
  });

  it("says how much is left this week when a Lifestyle budget exists, else keeps the month wording", async () => {
    const h = harness({ vapid });
    await subscribe(h);
    const id1 = (await (await apple(h)).json<{ id: string }>()).id;
    const t1 = await (await h.call(`/api/transactions/${id1}`)).json<never>();
    expect(await buildPurchaseNudgeBody(h.e, h.deps, t1)).toMatch(/— Lifestyle S\$.* \(day 14\/31\)$/);

    await setBudget(h);
    await env.DB.prepare("UPDATE transactions SET category_id = 'coffee' WHERE id = ?").bind(id1).run();
    const t = await (await h.call(`/api/transactions/${id1}`)).json<never>();
    const body = await buildPurchaseNudgeBody(h.e, h.deps, t);
    expect(body).toBe("S$14.50 · YA KUN · Coffee/Snacks — S$189 left this week"); // (20323 − 1450) = 18873
    expect(body.endsWith("left this week")).toBe(true);
  });
});
