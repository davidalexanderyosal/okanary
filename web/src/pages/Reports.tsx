import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, Pie, PieChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { expectedByDay } from "@okanary/core";
import { api, type Summary } from "../lib/api";
import { useResource } from "../lib/data";
import { monthLabel, prettyMerchant, sgd, shortDate } from "../lib/format";
import { currentMonth } from "../lib/month";
import { useRefData } from "../lib/refdata";
import { groupColor } from "../components/groups";
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

function Trend({ month }: { month: string }) {
  const t = useResource("trend:6", () => api.trend(6, "lifestyle")).data;
  const data = (t?.points ?? []).map((p) => ({ ...p, label: monthLabel(p.month).slice(0, 3) }));
  return (
    <Card title="Lifestyle, last 6 months">
      <div className="h-52" aria-label="Lifestyle trend">
        <ResponsiveContainer>
          <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="var(--line)" vertical={false} />
            <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} />
            <YAxis tick={AXIS} tickFormatter={axisMoney} tickLine={false} axisLine={false} width={38} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [sgd(v, false), "Lifestyle"]} />
            <Bar dataKey="group" radius={[6, 6, 0, 0]} isAnimationActive={false}>
              {data.map((p) => <Cell key={p.month} fill="var(--lifestyle)" opacity={p.month === month ? 1 : 0.55} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
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
      {tab === "daily" && s && <Daily s={s} month={month} />}
      {tab === "merchants" && s && <Merchants s={s} />}
      {tab === "trend" && <Trend month={month} />}
      {tab === "cards" && <Cards />}
      <div className="h-6" />
    </div>
  );
}
