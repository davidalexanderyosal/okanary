import { BALANCE_STALE_DAYS, addMonths, balanceAgeDays, changeOverRange, daysInMonth, formatMoneyShort, latestBalance, sgtDate, sgtMonth, type NwAccount, type NwBalance, type NwSnapshotRow } from "@okanary/core";
import type { Deps } from "./deps";
import type { Env } from "./env";
import { loadGoals } from "./goals";
import { sendNudge } from "./nudge-gate";
import { nowIso, ulid } from "./util";

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Explicit sign: "+S$1,240" / "-S$300". */
const signed = (minor: number) => (minor > 0 ? "+" : "") + formatMoneyShort(minor);

/** Extra lines for the monthly summary: feature G adds the goals line, feature P will add the plan check-in. */
export async function monthlySummaryExtras(env: Env, deps: Deps): Promise<string[]> {
  const line = (await loadGoals(env.DB, deps.now())).summary;
  return line ? [line] : [];
}

/** Accounts whose latest balance is older than BALANCE_STALE_DAYS (the one reminder; the net worth screen shows a chip). */
export async function staleBalanceCount(env: Env, today: string): Promise<number> {
  const accounts = (await env.DB.prepare("SELECT * FROM nw_accounts WHERE archived = 0 AND include_in_networth = 1").all<NwAccount>()).results;
  const balances = (await env.DB.prepare("SELECT * FROM nw_balances").all<NwBalance>()).results;
  let n = 0;
  for (const a of accounts) {
    const b = latestBalance(balances, a.id, today);
    const age = balanceAgeDays(b?.as_of ?? null, today);
    if (age != null && age > BALANCE_STALE_DAYS) n++;
  }
  return n;
}

/**
 * 1st of the month, 09:00 SGT (hourly cron): net worth change over the month just ended, split into saved vs market, plus
 * the stale-balance reminder and extras from goals/plan. Once per month (alert_log), through the nudge gate. Never about
 * daily market moves.
 */
export async function sendMonthlySummary(env: Env, deps: Deps): Promise<{ sent: boolean; body?: string }> {
  const now = deps.now();
  const today = sgtDate(now);
  const ended = addMonths(sgtMonth(now), -1);
  const from = `${addMonths(ended, -1)}-${String(daysInMonth(addMonths(ended, -1))).padStart(2, "0")}`;
  const to = `${ended}-${String(daysInMonth(ended)).padStart(2, "0")}`;

  const rows = (await env.DB.prepare("SELECT date, net_sgd_minor, flows_sgd_minor, market_sgd_minor FROM networth_snapshots ORDER BY date").all<NwSnapshotRow>()).results;
  const ch = changeOverRange(rows, from, to);
  const monthName = MONTH_NAMES[Number(ended.slice(5)) - 1]!;
  let body: string | null = null;
  if (ch && ch.to > from && ch.to > ch.from) {
    body = `${monthName}: net worth ${signed(ch.change)} (you saved ${signed(ch.flows)} · market ${signed(ch.market)}).`;
  }
  const items: string[] = [];
  const stale = await staleBalanceCount(env, today);
  if (stale > 0) items.push(`${stale} balance${stale === 1 ? "" : "s"} need${stale === 1 ? "s" : ""} updating`);
  items.push(...(await monthlySummaryExtras(env, deps)));
  if (items.length) body = body ? body + items.map((i) => ` · ${i}`).join("") : `${monthName}: ${items.join(" · ")}`;
  if (!body) return { sent: false };

  const claimed = await env.DB.prepare("INSERT OR IGNORE INTO alert_log (id, kind, ref, period, sent_at) VALUES (?,?,?,?,?)").bind(ulid(), "monthly_summary", "all", ended, nowIso()).run();
  if (!claimed.meta.changes) return { sent: false };
  await sendNudge(env, deps, { title: "Okanary: your month", body, url: "/money/networth", tag: "monthly-summary" }, "monthly_summary");
  return { sent: true, body };
}
