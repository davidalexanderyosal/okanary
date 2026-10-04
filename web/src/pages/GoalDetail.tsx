import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { sgtDate } from "@okanary/core";
import { api, type GoalDetail as GoalDetailData } from "../lib/api";
import { invalidateAll, useResource } from "../lib/data";
import { sgd, shortDate } from "../lib/format";
import {
  DISCLAIMER, STATUS_LABEL, SOURCE_LABEL, assumptionsText, behindText, buildChartData, fundingSummary, inflatedText, monthYear, plannedText, pledgedText, progressPct, requiredVsPaceText,
  warningText, type NameLookup,
} from "../lib/goals";
import { parseMoneyInput } from "../lib/networth";
import { GoalEditor } from "../components/GoalEditor";
import { PledgeRow, StatusChip } from "../components/GoalBits";
import { MoneyTabs } from "../components/MoneyTabs";
import { useToast } from "../components/Toast";

const AXIS = { fontSize: 11, fill: "var(--muted)" } as const;
const tooltipStyle = { background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, fontSize: 12, color: "var(--fg)" } as const;
const axisDollars = (v: number) => (Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : String(Math.round(v)));
const field = "tap w-full rounded-xl border border-line bg-bg px-3";
const softBtn = "tap rounded-full border-2 border-dashed border-lilac bg-card px-4 text-[13px] font-extrabold text-accent active:bg-line/40 disabled:opacity-50";
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const dollars = (v: number) => sgd(Math.round(v * 100));

function Card({ title, right, children, tint }: { title?: string; right?: ReactNode; children: ReactNode; tint?: boolean }) {
  return (
    <section className={`mt-3 rounded-3xl p-4 shadow-sm ${tint ? "border border-lifestyle bg-pill" : "bg-card"}`}>
      {(title || right) && (
        <div className="flex items-center justify-between gap-2 pb-2">
          <h2 className="text-sm font-semibold text-muted">{title}</h2>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function GoalDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const detail = useResource(`goal:${id}`, () => api.goal(id));
  const nw = useResource("networth", api.networth).data;
  const [editing, setEditing] = useState<"all" | "funding" | null>(null);
  const g = detail.data;
  const names: NameLookup = useMemo(() => ({
    account: (aid) => nw?.accounts.find((a) => a.id === aid)?.name,
    holding: (hid) => nw?.holdings.find((h) => h.id === hid)?.symbol,
  }), [nw]);

  const header = (
    <>
      <MoneyTabs />
      <Link to="/money/goals" className="tap mt-2 flex items-center px-1 text-xs font-bold text-accent">‹ All goals</Link>
    </>
  );

  if (!g) {
    return (
      <div className="px-4 pb-6 pt-safe">
        {header}
        <p className="px-1 pt-8 text-center text-sm text-muted">{detail.error ? "This goal isn't available any more." : "…"}</p>
      </div>
    );
  }

  const pct = progressPct(g.value, g.target);
  const behind = behindText(g.status);
  const planned = plannedText(g.planned_monthly_minor);
  const pledged = pledgedText(g.totals.pledged);
  const inflated = inflatedText(g.target_today_minor, g.target, g.target_date);
  const reached = g.status.state === "reached";

  return (
    <div className="px-4 pb-6 pt-safe">
      {header}
      <section className="receipt relative mt-2 rounded-[22px] bg-card p-4 shadow-sm" aria-label={g.name}>
        <div className="flex items-start justify-between gap-2">
          <h1 className="min-w-0 text-lg font-extrabold">{g.emoji ? `${g.emoji} ` : ""}{g.name}</h1>
          <StatusChip goal={g} />
        </div>
        <p className="big-num pt-1 text-[34px] leading-[1.1]">{sgd(g.value)}</p>
        <p className="num text-xs text-muted">of {sgd(g.target)}{g.target_date ? ` by ${monthYear(g.target_date)}` : ""}</p>
        {inflated && <p className="num text-xs text-muted">{inflated}</p>}
        <div className="mt-3 h-3 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${pct}% of the target`}>
          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: "var(--savings)" }} />
        </div>
        {pledged && <p className="num mt-2 text-xs text-muted">{pledged}</p>}
        {!reached && <p className="num mt-2 text-sm">{requiredVsPaceText(g.status.required, g.pace)}</p>}
        {planned && <p className="num text-xs text-muted">{planned}</p>}
        {behind && <p className="mt-1 text-sm font-semibold text-lifestyle-ink">{behind}</p>}
        {g.status.state === "ahead" && <p className="mt-1 text-sm text-good">At this pace you'd finish about {sgd(g.status.surplus)} above target.</p>}
      </section>

      {g.warnings.length > 0 && (
        <Card tint>
          <p className="text-xs font-bold text-lifestyle-ink">A gentle heads-up</p>
          <ul className="space-y-1 pt-1 text-xs text-lifestyle-ink">{g.warnings.map((w, i) => <li key={i}>{warningText(w, names)}</li>)}</ul>
        </Card>
      )}

      {g.safer_funding_suggested && (
        <Card tint>
          <h2 className="text-sm font-extrabold text-lifestyle-ink">Move to safer funding?</h2>
          <p className="pt-1 text-xs text-lifestyle-ink">This goal is now under 2 years away. Money needed soon shouldn't depend on market swings, so you may want to fund it from cash instead of stocks or crypto.</p>
          <button className={`${softBtn} mt-2`} onClick={() => setEditing("funding")}>Review funding</button>
        </Card>
      )}

      {g.pledges.length > 0 && (
        <Card title="Waiting for you">
          <div className="space-y-1.5">{g.pledges.map((p) => <PledgeRow key={p.id} pledge={p} />)}</div>
        </Card>
      )}

      <ProjectionChart g={g} />

      <Card title="Assumptions" right={<button className="tap px-2 text-xs font-bold text-accent underline" onClick={() => setEditing("all")}>Edit</button>}>
        <p className="num text-sm">{assumptionsText(g)}</p>
        <p className="pt-1 text-xs text-muted">Funding: {fundingSummary(g.funding, names)}</p>
        <button className="tap -ml-1 px-1 text-xs font-bold text-accent underline" onClick={() => setEditing("funding")}>Edit funding</button>
        <p className="pt-1 text-xs text-muted">{DISCLAIMER}</p>
      </Card>

      <Contributions g={g} />

      {editing && <GoalEditor goal={g} section={editing === "funding" ? "funding" : undefined} onClose={() => setEditing(null)} onArchived={() => navigate("/money/goals")} />}
    </div>
  );
}

// ------------------------------------------------------------------ chart

function ProjectionChart({ g }: { g: GoalDetailData }) {
  const data = useMemo(() => buildChartData({ today: sgtDate(new Date()), value: g.value, history: g.history, path: g.path, cone: g.cone }), [g]);
  const target = g.target / 100;
  const hasHistory = g.history.length > 0;
  return (
    <Card title="Where this is heading">
      <div className="h-60" aria-label="Goal progress and projection">
        <ResponsiveContainer>
          <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="var(--line)" vertical={false} />
            <XAxis
              dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} tick={AXIS} tickLine={false} axisLine={false} minTickGap={36}
              tickFormatter={(t: number) => monthYear(new Date(t).toISOString().slice(0, 10))}
            />
            <YAxis tick={AXIS} tickFormatter={axisDollars} tickLine={false} axisLine={false} width={40} />
            <Tooltip
              contentStyle={tooltipStyle}
              labelFormatter={(t: number) => shortDate(new Date(t).toISOString().slice(0, 10))}
              formatter={(v: number | [number, number], name: string) => [
                Array.isArray(v) ? `${dollars(v[0])} to ${dollars(v[1])}` : dollars(v),
                name === "actual" ? "So far" : name === "projected" ? "At current pace" : "Range",
              ]}
            />
            {g.cone && <Area dataKey="band" name="band" stroke="none" fill="var(--lilac)" fillOpacity={0.35} isAnimationActive={false} />}
            <ReferenceLine y={target} stroke="var(--accent)" strokeDasharray="5 4" ifOverflow="extendDomain" label={{ value: "Target", position: "insideTopLeft", fill: "var(--muted)", fontSize: 11 }} />
            <Line dataKey="projected" name="projected" stroke="var(--accent)" strokeWidth={2} strokeDasharray="6 4" dot={false} connectNulls isAnimationActive={false} />
            <Line dataKey="actual" name="actual" stroke="var(--good)" strokeWidth={2.5} dot={{ r: 2.5 }} connectNulls isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 pt-1 text-xs">
        <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded" style={{ background: "var(--good)" }} />So far</span>
        <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded border-t-2 border-dashed" style={{ borderColor: "var(--accent)" }} />At current pace</span>
        {g.cone && <span className="flex items-center gap-1.5"><span className="h-2.5 w-4 rounded" style={{ background: "var(--lilac)", opacity: 0.6 }} />Conservative to optimistic</span>}
      </div>
      {!hasHistory && <p className="pt-2 text-center text-xs text-muted">The line of what you've saved so far fills in as daily snapshots build up.</p>}
      {g.range && (
        <p className="num pt-2 text-xs text-muted">
          At the target date: {sgd(g.range.conservative)} conservative · {sgd(g.range.base)} base · {sgd(g.range.optimistic)} optimistic (return −2 / base / +2 points).
        </p>
      )}
      {g.pace == null && <p className="pt-1 text-xs text-muted">The projection assumes S$0 a month until there is enough history to measure your pace.</p>}
    </Card>
  );
}

// ------------------------------------------------------------------ contributions

function Contributions({ g }: { g: GoalDetailData }) {
  const toast = useToast();
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    const m = parseMoneyInput(amount, "SGD");
    if (m == null || m < 1) return setError("Enter the amount you moved, above zero.");
    setError(null);
    setBusy(true);
    try {
      await api.addGoalContribution(g.id, { amount_sgd_minor: m, status: "transferred" });
      invalidateAll();
      setAmount("");
      toast({ msg: "Added to your history" });
    } catch (e) {
      setError(`Couldn't save: ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Contributions">
      {g.contributions.length === 0 && <p className="pb-1 text-sm text-muted">Nothing yet. Pledges you mark as moved, and transfers you log here, show up in this list.</p>}
      <div className="divide-y divide-line">
        {g.contributions.map((c) => (
          <div key={c.id} className="flex items-center justify-between gap-2 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{SOURCE_LABEL[c.source] ?? c.source}</p>
              <p className="text-xs text-muted">{shortDate(sgtDate(c.resolved_at ?? c.created_at))} · {STATUS_LABEL[c.status] ?? c.status}</p>
            </div>
            <span className={`num shrink-0 text-sm ${c.status === "skipped" ? "text-muted line-through" : ""}`}>{sgd(c.amount_sgd_minor)}</span>
          </div>
        ))}
      </div>
      <div className="mt-2 space-y-2 rounded-2xl border border-dashed border-line p-3">
        <label className="block text-xs font-bold text-muted">Log a transfer you made
          <input className={`${field} mt-1 font-normal`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 200" />
        </label>
        {error && <p role="alert" className="text-xs font-semibold text-lifestyle-ink">{error}</p>}
        <button className={softBtn} disabled={busy} onClick={() => void add()}>Add transfer</button>
        {!g.value_parts.counts_contributions && g.totals.transferred > 0 && (
          <p className="text-[11px] text-muted">This goal's progress comes from its linked accounts, so transfers are kept as history and not counted twice.</p>
        )}
      </div>
    </Card>
  );
}
