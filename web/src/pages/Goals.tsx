import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type GoalView } from "../lib/api";
import { invalidateAll, useResource } from "../lib/data";
import { sgd } from "../lib/format";
import {
  DISCLAIMER, behindText, emergencySuggestionText, fundingSummary, groupByHorizon, inflatedText, moveInGroup, monthYear, plannedText, pledgedText, progressPct, requiredVsPaceText, warningText, type NameLookup,
} from "../lib/goals";
import { GoalEditor } from "../components/GoalEditor";
import { PledgeRow, StatusChip } from "../components/GoalBits";
import { MoneyTabs } from "../components/MoneyTabs";
import { useToast } from "../components/Toast";

const softBtn = "tap rounded-full border-2 border-dashed border-lilac bg-card px-4 text-[13px] font-extrabold text-accent active:bg-line/40 disabled:opacity-50";
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

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

export function Goals() {
  const toast = useToast();
  const goals = useResource("goals", api.goals);
  const nw = useResource("networth", api.networth).data;
  const suggestion = useResource("goals:emergency", api.emergencySuggestion).data;
  const [params] = useSearchParams();
  const pledgeId = params.get("pledge");
  const [editing, setEditing] = useState<{ goal: GoalView | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const scrolled = useRef<string | null>(null);

  const data = goals.data;
  const list = data?.goals ?? [];
  const names: NameLookup = useMemo(() => ({
    account: (id) => nw?.accounts.find((a) => a.id === id)?.name,
    holding: (id) => nw?.holdings.find((h) => h.id === id)?.symbol,
  }), [nw]);
  const openPledges = list.flatMap((g) => g.pledges.map((p) => ({ p, g })));
  const groups = groupByHorizon(list);
  const showSuggestion = !!data && !list.some((g) => g.kind === "emergency") && suggestion?.target != null && suggestion.target > 0 && suggestion.months.length > 0;

  // Notification deep link: /money/goals?pledge=<id> scrolls to (and highlights) that pledge once it is on the page.
  useEffect(() => {
    if (!pledgeId || scrolled.current === pledgeId) return;
    const el = document.getElementById(`pledge-${pledgeId}`);
    if (!el) return;
    scrolled.current = pledgeId;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [pledgeId, data]);

  async function move(id: string, dir: -1 | 1) {
    const ids = moveInGroup(list, id, dir);
    if (!ids) return;
    try {
      await api.reorderGoals(ids);
      invalidateAll();
    } catch (e) {
      toast({ msg: `Couldn't reorder: ${errMsg(e)}` });
    }
  }

  async function createEmergency() {
    if (suggestion?.target == null) return;
    setBusy(true);
    try {
      await api.createGoal({ name: "Emergency fund", emoji: "🛟", kind: "emergency", target_today_minor: suggestion.target });
      invalidateAll();
      toast({ msg: "Emergency fund added" });
    } catch (e) {
      toast({ msg: `Couldn't add it: ${errMsg(e)}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="px-4 pb-6 pt-safe">
      <MoneyTabs />
      <div className="flex items-center justify-between gap-2 px-1 pt-4">
        <h1 className="text-lg font-extrabold">Goals</h1>
        <button className={`${softBtn} !min-h-9 !px-3 text-xs`} onClick={() => setEditing({ goal: null })}>Add a goal</button>
      </div>

      {goals.error && !data && <p className="px-1 pt-6 text-center text-sm text-muted">Couldn't load your goals just now. Pull to refresh in a moment.</p>}
      {!data && !goals.error && <p className="px-1 pt-6 text-center text-sm text-muted">…</p>}

      {data?.summary && <p className="num mt-2 rounded-full bg-card px-4 py-2 text-[13px] shadow-sm" aria-label="Goals summary">{data.summary}</p>}

      {data && data.warnings.length > 0 && (
        <Card tint>
          <p className="text-xs font-bold text-lifestyle-ink">A gentle heads-up</p>
          <ul className="space-y-1 pt-1 text-xs text-lifestyle-ink">
            {data.warnings.map((w, i) => <li key={i}>{warningText(w, names)}</li>)}
          </ul>
        </Card>
      )}

      {openPledges.length > 0 && (
        <Card title="Waiting for you">
          <p className="pb-2 text-xs text-muted">Okanary can't move money. Move it yourself, then tap Transferred, or Skip if it's not for now.</p>
          <div className="space-y-1.5">
            {openPledges.map(({ p, g }) => (
              <PledgeRow key={p.id} pledge={p} goalLabel={`${g.emoji ? `${g.emoji} ` : ""}${g.name}`} highlight={p.id === pledgeId} anchorId />
            ))}
          </div>
        </Card>
      )}

      {showSuggestion && suggestion && (
        <Card>
          <p className="text-sm font-semibold">{emergencySuggestionText(suggestion.target!, suggestion.months.length)}</p>
          <p className="pt-1 text-xs text-muted">A buffer for surprises, funded from cash. Six months because part of your pay is commission.</p>
          <button className={`${softBtn} mt-2`} disabled={busy} onClick={() => void createEmergency()}>Create</button>
        </Card>
      )}

      {data && list.length === 0 && (
        <Card>
          <p className="py-2 text-center text-sm text-muted">No goals yet. A goal with a date shows whether you're on pace and what a monthly top-up would do.</p>
          <div className="flex justify-center pb-1"><button className={softBtn} onClick={() => setEditing({ goal: null })}>Add a goal</button></div>
        </Card>
      )}

      {groups.map((grp) => (
        <section key={grp.horizon} aria-label={grp.label}>
          <h2 className="px-1 pb-0.5 pt-4 text-[13px] font-extrabold text-muted">{grp.label}</h2>
          {grp.items.map((g, i) => (
            <GoalCard
              key={g.id} goal={g} names={names} receiving={g.id === data?.receiving_goal_id} pledgeId={pledgeId}
              canUp={i > 0} canDown={i < grp.items.length - 1}
              onMove={(d) => void move(g.id, d)} onEdit={() => setEditing({ goal: g })}
            />
          ))}
        </section>
      ))}

      <p className="px-1 pt-5 text-center text-xs text-muted">{DISCLAIMER}</p>

      {editing && <GoalEditor goal={editing.goal} onClose={() => setEditing(null)} />}
    </div>
  );
}

function GoalCard({ goal: g, names, receiving, pledgeId, canUp, canDown, onMove, onEdit }: {
  goal: GoalView; names: NameLookup; receiving: boolean; pledgeId: string | null; canUp: boolean; canDown: boolean; onMove: (d: -1 | 1) => void; onEdit: () => void;
}) {
  const pct = progressPct(g.value, g.target);
  const behind = behindText(g.status);
  const planned = plannedText(g.planned_monthly_minor);
  const pledged = pledgedText(g.totals.pledged);
  const inflated = inflatedText(g.target_today_minor, g.target, g.target_date);
  const reached = g.status.state === "reached";
  const arrow = "tap grid w-9 place-items-center rounded-full text-sm font-bold text-muted active:bg-line/40 disabled:opacity-30";
  return (
    <article className="mt-2 rounded-3xl bg-card p-4 shadow-sm" aria-label={g.name}>
      <div className="flex items-start justify-between gap-2">
        <Link to={`/money/goals/${g.id}`} className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-[15px] font-extrabold">{g.emoji ? `${g.emoji} ` : ""}{g.name}</span>
            <StatusChip goal={g} />
          </span>
        </Link>
        <div className="flex shrink-0 items-center">
          <button className={arrow} disabled={!canUp} aria-label={`Move ${g.name} up`} onClick={() => onMove(-1)}>▲</button>
          <button className={arrow} disabled={!canDown} aria-label={`Move ${g.name} down`} onClick={() => onMove(1)}>▼</button>
        </div>
      </div>

      <Link to={`/money/goals/${g.id}`} className="block">
        <div className="mt-2 h-3 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${pct}% of the target`}>
          <div className="h-full rounded-full transition-[width]" style={{ width: `${pct}%`, background: "var(--savings)" }} />
        </div>
        <p className="num mt-1 flex justify-between text-xs"><span>{sgd(g.value)} of {sgd(g.target)}</span><span className="text-muted">{pct}%</span></p>
        {inflated && <p className="num text-[11px] text-muted">{inflated}</p>}
        {pledged && <p className="num mt-0.5 text-xs text-muted">{pledged}</p>}
        {!reached && <p className="num mt-1 text-xs">{requiredVsPaceText(g.status.required, g.pace)}</p>}
        {planned && <p className="num text-xs text-muted">{planned}</p>}
        {behind && <p className="mt-1 text-xs font-semibold text-lifestyle-ink">{behind}</p>}
        <p className="mt-1 text-xs text-muted">
          {g.target_date ? `Target ${monthYear(g.target_date)}` : "No target date"} · {fundingSummary(g.funding, names)}
        </p>
      </Link>

      {receiving && <p className="mt-2 inline-block rounded-full border border-lilac px-2.5 py-0.5 text-[11px] font-bold text-accent">Receives last week's underspend</p>}

      {g.pledges.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {g.pledges.map((p) => <PledgeRow key={p.id} pledge={p} highlight={p.id === pledgeId} />)}
        </div>
      )}

      <div className="mt-2 flex items-center justify-between">
        <Link to={`/money/goals/${g.id}`} className="tap flex items-center text-xs font-bold text-accent">Details ›</Link>
        <button className="tap px-2 text-xs font-bold text-accent" onClick={onEdit} aria-label={`Edit ${g.name}`}>Edit</button>
      </div>
    </article>
  );
}
