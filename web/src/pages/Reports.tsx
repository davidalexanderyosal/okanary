import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, Pie, PieChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { addMonths, expectedByDay } from "@okanary/core";
import { api, type Summary } from "../lib/api";
import { useResource } from "../lib/data";
import { monthLabel, prettyMerchant, sgd, shortDate } from "../lib/format";
import { currentMonth } from "../lib/month";
import { useRefData } from "../lib/refdata";
import { groupColor } from "../components/groups";
import { NO_HISTORY_TEXT, usualDiffText, usualToneClass } from "../lib/usual";
import { MonthStepper } from "./Transactions";

type Tab = "overview" | "daily" | "merchants" | "trend" | "cards";
const TABS: [Tab, string][] = [["overview", "Overview"], ["daily", "Daily"], ["merchants", "Merchants"], ["trend", "Trend"], ["cards", "Cards"]];
const AXIS = { fontSize: 11, fill: "var(--muted)" } as const;
const tooltipStyle = { background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, fontSize: 12, color: "var(--fg)" } as const;
const axisMoney = (v: number) => (Math.abs(v) >= 100000 ? `${Math.round(v / 100000)}k` : String(Math.round(v / 100)));

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-4 rounded-3xl bg-card p-4 shadow-sm">
      <h2 className="pb-2 text-sm font-semibold text-muted">{title}</h2>
      {children}
    </section>
  );
}

function Overview({ s }: { s: Summary }) {
  const ref = useRefData();
  const groupName = (id: string) => ref.groups.find((g) => g.id === id)?.name ?? "Uncategorised";
  const catName = (id: string) => ref.categoryMap.get(id)?.name ?? "Uncategorised";
  const groupOf = (id: string) => ref.categoryMap.get(id)?.group_id ?? "uncategorised";
  const pie = s.byGroup.filter((b) => b.spent > 0);
  const cats = s.byCategory.filter((b) => b.spent > 0);
  const max = Math.max(...cats.map((c) => c.spent), 1);
  return (
    <>
      {pie.length > 0 && (
        <div className="h-52" aria-label="Spend by group">
          <ResponsiveContainer>
            <PieChart>
              <Pie data={pie} dataKey="spent" nameKey="id" innerRadius="58%" outerRadius="90%" paddingAngle={2} stroke="none" isAnimationActive={false}>
                {pie.map((b) => <Cell key={b.id} fill={groupColor(b.id)} />)}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
        </div>
      )}
      <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs">
        {pie.map((b) => (
          <span key={b.id} className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: groupColor(b.id) }} />{groupName(b.id)} <span className="num text-muted">{sgd(b.spent)}</span></span>
        ))}
      </div>
      <section className="mb-6 mt-5 rounded-3xl bg-card p-4 shadow-sm">
        <h2 className="pb-2 text-sm font-semibold text-muted">By category</h2>
        {cats.length === 0 && <p className="py-4 text-center text-sm text-muted">No spend this month.</p>}
        <div className="space-y-3">
          {cats.map((c) => (
            <div key={c.id}>
              <div className="flex justify-between text-sm"><span>{catName(c.id)}</span><span className="num font-medium">{sgd(c.spent)}</span></div>
              <div className="mt-1 h-2 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full" style={{ width: `${(c.spent * 100) / max}%`, background: groupColor(groupOf(c.id)) }} /></div>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

/** "Vs your usual" (v2 U): each category this month to date against the average of the same days in recent months. */
function VsUsual() {
  const ref = useRefData();
  const u = useResource("usual", api.usual).data;
  if (!u) return null;
  const { month } = u;
  const none = month.total.comparison.state === "no_history";
  const max = Math.max(...month.categories.map((c) => Math.max(c.current, c.usual ?? 0)), 1);
  return (
    <Card title="Vs your usual">
      {none ? (
        <p className="py-2 text-sm text-muted">{NO_HISTORY_TEXT}</p>
      ) : (
        <>
          <p className="pb-2 text-xs text-muted">Day 1 to {month.day} of this month vs the same days in recent months{` (based on ${month.periods.length} ${month.periods.length === 1 ? "month" : "months"})`}.</p>
          <div className="space-y-3">
            {month.categories.map((c) => {
              const d = usualDiffText(c);
              return (
                <div key={c.id}>
                  <div className="flex justify-between gap-2 text-sm">
                    <span className="truncate">{ref.categoryMap.get(c.id)?.name ?? "Uncategorised"}</span>
                    <span className="num shrink-0 font-medium">{sgd(c.current)} <span className="text-xs font-normal text-muted">vs {sgd(c.usual ?? 0)}</span> <span className={`text-xs font-normal ${usualToneClass[d.tone]}`}>{d.text}</span></span>
                  </div>
                  <div className="relative mt-1 h-2 overflow-hidden rounded-full bg-line">
                    <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${(c.current * 100) / max}%`, background: d.tone === "amber" ? "var(--lifestyle)" : "var(--accent)" }} />
                    <div className="absolute inset-y-0 w-0.5 bg-fg/60" style={{ left: `${Math.min(((c.usual ?? 0) * 100) / max, 100)}%` }} aria-hidden />
                  </div>
                </div>
              );
            })}
            {month.categories.length === 0 && <p className="text-sm text-muted">No spend yet this month.</p>}
          </div>
          <p className="pt-2 text-xs text-muted">Bar: this month so far · tick: your usual.</p>
        </>
      )}
    </Card>
  );
}

/** Daily bars + cumulative line vs the budget pace line (spec §7.5). */
function Daily({ s, month }: { s: Summary; month: string }) {
  const ref = useRefData();
  const [scope, setScope] = useState<"all" | "lifestyle">("lifestyle");
  const spendGroups = new Set(ref.groups.filter((g) => g.counts_as_spend).map((g) => g.id));
  const budget = scope === "lifestyle"
    ? s.budgets.find((b) => b.scope === "group" && b.ref_id === "lifestyle")?.monthly_amount_sgd_minor ?? 0
    : s.budgets.filter((b) => b.scope === "group" && spendGroups.has(b.ref_id)).reduce((a, b) => a + b.monthly_amount_sgd_minor, 0);
  const series = scope === "lifestyle" ? s.dailyByGroup.lifestyle ?? Array.from({ length: s.daysInMonth }, () => 0) : s.daily;
  const isCurrent = month === currentMonth();
  const data = useMemo(() => {
    let cum = 0;
    return series.map((v, i) => {
      const day = i + 1;
      const future = isCurrent && day > s.day;
      if (!future) cum += v;
      return { day, spend: future ? null : v, cum: future ? null : cum, pace: budget ? expectedByDay(budget, day, s.daysInMonth) : null };
    });
  }, [series, isCurrent, s.day, s.daysInMonth, budget]);
  const color = scope === "lifestyle" ? "var(--lifestyle)" : "var(--accent)";
  return (
    <Card title="Daily spend vs pace">
      <div className="mb-2 flex gap-2">
        {(["lifestyle", "all"] as const).map((k) => (
          <button key={k} onClick={() => setScope(k)} className={`tap rounded-full border px-4 text-sm ${scope === k ? "border-accent bg-accent text-accent-fg" : "border-line"}`}>{k === "all" ? "All spend" : "Lifestyle"}</button>
        ))}
      </div>
      <div className="h-64" aria-label="Daily spend chart">
        <ResponsiveContainer>
          <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="var(--line)" vertical={false} />
            <XAxis dataKey="day" tick={AXIS} interval={4} tickLine={false} axisLine={false} />
            <YAxis tick={AXIS} tickFormatter={axisMoney} tickLine={false} axisLine={false} width={38} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v: number, n: string) => [sgd(v, false), n === "spend" ? "Day" : n === "cum" ? "Cumulative" : "Pace"]} labelFormatter={(d) => `Day ${d}`} />
            <Bar dataKey="spend" fill={color} radius={[3, 3, 0, 0]} opacity={0.55} isAnimationActive={false} />
            <Line type="monotone" dataKey="cum" stroke={color} strokeWidth={2.5} dot={false} connectNulls={false} isAnimationActive={false} />
            {budget > 0 && <Line type="linear" dataKey="pace" stroke="var(--muted)" strokeWidth={1.5} strokeDasharray="5 4" dot={false} isAnimationActive={false} />}
            {budget > 0 && <ReferenceLine y={budget} stroke="var(--danger)" strokeDasharray="2 4" />}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <p className="pt-1 text-xs text-muted">Bars: each day · solid line: month to date · dashed: even-pace line {budget > 0 ? `for your ${sgd(budget)} budget` : "(set a budget to see it)"}.</p>
    </Card>
  );
}

function Merchants({ s }: { s: Summary }) {
  const max = Math.max(...s.topMerchants.map((m) => m.spent), 1);
  return (
    <Card title="Top merchants">
      {s.topMerchants.length === 0 && <p className="py-4 text-center text-sm text-muted">No merchants yet.</p>}
      <div className="space-y-3">
        {s.topMerchants.map((m) => (
          <div key={m.id}>
            <div className="flex justify-between text-sm"><span className="truncate">{prettyMerchant(m.id)} <span className="text-xs text-muted">×{m.count}</span></span><span className="num font-medium">{sgd(m.spent)}</span></div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-accent" style={{ width: `${(m.spent * 100) / max}%` }} /></div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function Delta({ now, prev }: { now: number; prev: number }) {
  if (prev === 0 && now === 0) return <span className="text-muted">–</span>;
  if (prev === 0) return <span className="text-muted">new</span>;
  const pct = Math.round(((now - prev) * 100) / prev);
  return <span className={pct > 0 ? "text-danger" : "text-good"}>{pct > 0 ? "▲" : pct < 0 ? "▼" : ""} {Math.abs(pct)}%</span>;
}

/** Month-over-month per group/category plus a 6-month trend for any one of them (spec §3.2). */
function Trend({ month, s }: { month: string; s: Summary }) {
  const ref = useRefData();
  const [target, setTarget] = useState("group:lifestyle");
  const prevMonth = addMonths(month, -1);
  const prev = useResource(`summary:${prevMonth}`, () => api.summary(prevMonth)).data;
  const [kind, id] = target.split(":") as ["group" | "category", string];
  const t = useResource(`trend:6:${target}`, () => (kind === "group" ? api.trend(6, id) : api.trend(6, "lifestyle", id))).data;
  const data = (t?.points ?? []).map((p) => ({ ...p, label: monthLabel(p.month).slice(0, 3) }));
  const color = kind === "group" ? groupColor(id) : groupColor(ref.categoryMap.get(id)?.group_id);
  const spendGroups = ref.groups.filter((g) => g.counts_as_spend);
  const get = (sum: Summary | undefined, scope: "group" | "category", k: string) => (scope === "group" ? sum?.byGroup : sum?.byCategory)?.find((b) => b.id === k)?.spent ?? 0;
  const catRows = ref.categories.filter((c) => !c.archived && (get(s, "category", c.id) || get(prev, "category", c.id)));
  return (
    <>
      <Card title="Six-month trend">
        <select className="tap mb-3 w-full rounded-xl border border-line bg-bg px-3 text-sm" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Group or category">
          <optgroup label="Groups">{spendGroups.map((g) => <option key={g.id} value={`group:${g.id}`}>{g.name}</option>)}</optgroup>
          {spendGroups.map((g) => (
            <optgroup key={g.id} label={`${g.name} categories`}>{ref.categories.filter((c) => c.group_id === g.id && !c.archived).map((c) => <option key={c.id} value={`category:${c.id}`}>{c.name}</option>)}</optgroup>
          ))}
        </select>
        <div className="h-52" aria-label="Trend chart">
          <ResponsiveContainer>
            <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="var(--line)" vertical={false} />
              <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} />
              <YAxis tick={AXIS} tickFormatter={axisMoney} tickLine={false} axisLine={false} width={38} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [sgd(v, false), "Spent"]} />
              <Bar dataKey="group" radius={[6, 6, 0, 0]} isAnimationActive={false}>
                {data.map((p) => <Cell key={p.month} fill={color} opacity={p.month === month ? 1 : 0.55} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>
      <Card title={`${monthLabel(month)} vs ${monthLabel(prevMonth)}`}>
        <p className="flex justify-between border-b border-line pb-2 text-sm font-semibold"><span>Total</span><span className="num">{sgd(s.total)} <span className="text-xs font-normal"><Delta now={s.total} prev={prev?.total ?? 0} /></span></span></p>
        {spendGroups.map((g) => (
          <p key={g.id} className="flex justify-between border-b border-line py-2 text-sm"><span>{g.name}</span><span className="num">{sgd(get(s, "group", g.id))} <span className="text-xs"><Delta now={get(s, "group", g.id)} prev={get(prev, "group", g.id)} /></span></span></p>
        ))}
        {catRows.map((c) => (
          <p key={c.id} className="flex justify-between py-1.5 text-sm text-muted"><span>{c.name}</span><span className="num">{sgd(get(s, "category", c.id))} <span className="text-xs"><Delta now={get(s, "category", c.id)} prev={get(prev, "category", c.id)} /></span></span></p>
        ))}
      </Card>
    </>
  );
}

function Cards() {
  const c = useResource("cycles", api.cycles).data;
  return (
    <>
      {c && c.cycles.length === 0 && <p className="py-8 text-center text-sm text-muted">Add a credit card in Settings to see its statement cycle.</p>}
      {c?.cycles.map((x) => (
        <Card key={x.account.id} title={x.account.name + (x.account.last4 ? ` ····${x.account.last4}` : "")}>
          {!x.configured ? (
            <p className="text-sm text-muted">Set this card's statement day in Settings to see what the next bill will be.</p>
          ) : (
            <>
              <p className="num text-3xl font-bold">{sgd(x.current_bill ?? 0)}</p>
              <p className="text-sm text-muted">since the {shortDate(x.last_statement!)} statement · next statement {shortDate(x.next_statement!)}</p>
              {x.current_bill !== x.current_spend && <p className="pt-1 text-xs text-muted">Includes {sgd((x.current_bill ?? 0) - (x.current_spend ?? 0))} that isn't counted as spend (reimbursable, excluded or savings).</p>}
              <div className="mt-3 rounded-2xl bg-bg p-3 text-sm">
                <p className="flex justify-between"><span>Last statement ({x.previous_count} transactions)</span><span className="num font-semibold">{sgd(x.previous_bill ?? 0)}</span></p>
                {x.due_date && <p className="flex justify-between pt-1"><span>Payment due</span><span className="font-semibold">{shortDate(x.due_date)}</span></p>}
              </div>
            </>
          )}
        </Card>
      ))}
    </>
  );
}

export function Reports() {
  const [month, setMonth] = useState(currentMonth());
  const [tab, setTab] = useState<Tab>("overview");
  const s = useResource(`summary:${month}`, () => api.summary(month)).data;
  return (
    <div className="px-4 pt-safe">
      <div className="pt-3"><MonthStepper month={month} onChange={setMonth} /></div>
      <p className="num mt-1 text-center text-3xl font-bold">{s ? sgd(s.total) : "…"}</p>
      <p className="text-center text-xs text-muted">total spend</p>
      <div className="-mx-4 mt-3 flex gap-2 overflow-x-auto px-4 pb-3" role="tablist">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`tap shrink-0 rounded-full border px-4 text-sm ${tab === k ? "border-accent bg-accent text-accent-fg" : "border-line bg-card"}`}>{label}</button>
        ))}
      </div>
      {tab === "overview" && s && <Overview s={s} />}
      {tab === "overview" && s && month === currentMonth() && <VsUsual />}
      {tab === "daily" && s && <Daily s={s} month={month} />}
      {tab === "merchants" && s && <Merchants s={s} />}
      {tab === "trend" && s && <Trend month={month} s={s} />}
      {tab === "cards" && <Cards />}
      <div className="h-6" />
    </div>
  );
}
