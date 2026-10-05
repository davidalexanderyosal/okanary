import { useState, type ReactNode } from "react";
import { minorToDecimalString, sgtDate, type FixedLine, type PlanOutput } from "@okanary/core";
import type { SplitRule } from "@okanary/core";
import { api, type IncomeKind } from "../lib/api";
import { invalidateAll } from "../lib/data";
import { sgd } from "../lib/format";
import { parseMoneyInput } from "../lib/networth";
import { DEFAULT_SPLIT_PERCENTS, acceptedText, applyOverrideEdits, splitBarSegments, splitPercentsTotal, splitRuleFromPercents, splitRuleToPercents, tradeOffCards, type SegmentKey, type SplitPercents, type TradeOffCard } from "../lib/plan";
import { Sheet } from "./Sheet";
import { useToast } from "./Toast";

export const field = "tap w-full rounded-xl border border-line bg-bg px-3";
export const primaryBtn = "tap w-full rounded-full bg-sun font-extrabold text-sun-fg shadow-[0_3px_0_var(--sun-edge)] active:translate-y-[3px] active:shadow-none disabled:opacity-50";
export const softBtn = "tap rounded-full border-2 border-dashed border-lilac bg-card px-4 text-[13px] font-extrabold text-accent active:bg-line/40 disabled:opacity-50";
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function Card({ title, right, children, tint }: { title?: string; right?: ReactNode; children: ReactNode; tint?: boolean }) {
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

const SEGMENT_COLOR: Record<SegmentKey, string> = {
  fixed: "var(--essentials)", goals: "var(--savings)", lifestyle: "var(--lifestyle)", unallocated: "var(--lilac)",
};

/** Stacked bar of fixed / goals / Lifestyle (+ unallocated savings) with the amounts underneath. */
export function SplitBar({ plan }: { plan: Pick<PlanOutput, "fixed" | "goals" | "lifestyle" | "unallocated"> }) {
  const segs = splitBarSegments(plan);
  if (segs.length === 0) return null;
  return (
    <div>
      <div className="flex h-4 overflow-hidden rounded-full bg-line" role="img" aria-label={segs.map((s) => `${s.label} ${s.pct}%`).join(", ")}>
        {segs.map((s) => <div key={s.key} style={{ width: `${s.pct}%`, background: SEGMENT_COLOR[s.key] }} />)}
      </div>
      <ul className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
        {segs.map((s) => (
          <li key={s.key} className="flex items-center justify-between gap-2 text-xs">
            <span className="flex min-w-0 items-center gap-1.5">
              <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: SEGMENT_COLOR[s.key] }} />
              <span className="truncate">{s.label}</span>
            </span>
            <span className="num">{sgd(s.amount)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Accept the plan (optionally with the extended goal dates) and tell David what his Lifestyle budget became. */
export function useAcceptPlan(month: string) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function accept(extend = false): Promise<boolean> {
    setBusy(true);
    try {
      const r = await api.acceptPlan({ month, extend });
      invalidateAll();
      if (!r.needs_income) toast({ msg: acceptedText(r.plan.lifestyle, month) });
      return true;
    } catch (e) {
      toast({ msg: `Couldn't save the plan: ${errMsg(e)}` });
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { accept, busy };
}

/** Calm option cards for a plan that doesn't fit yet. */
export function TradeOffCards({ tradeOffs, onUseDates, busy }: { tradeOffs: PlanOutput["tradeOffs"]; onUseDates: () => void; busy: boolean }) {
  const cards: TradeOffCard[] = tradeOffCards(tradeOffs);
  return (
    <div className="space-y-2">
      {cards.map((c) => (
        <article key={c.kind} className="rounded-2xl border border-lifestyle bg-pill p-3" aria-label={c.title}>
          <h3 className="text-[13px] font-extrabold text-lifestyle-ink">{c.title}</h3>
          {c.lines.length > 0 && (
            <ul className="num space-y-0.5 pt-1 text-xs">{c.lines.map((l) => <li key={l}>{l}</li>)}</ul>
          )}
          {c.note && <p className="pt-1 text-xs text-muted">{c.note}</p>}
          {c.canUse && <button className={`${softBtn} mt-2 !min-h-9 text-xs`} disabled={busy} onClick={onUseDates}>Use these dates</button>}
        </article>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- sheets (mount only while open, so their state starts fresh)

/** Base take-home, after CPF. Edits the income in force from this month. */
export function IncomeBaseSheet({ current, onClose }: { current: number | null; onClose: () => void }) {
  const toast = useToast();
  const [v, setV] = useState(current != null ? minorToDecimalString(current, "SGD") : "");
  const [busy, setBusy] = useState(false);
  const minor = parseMoneyInput(v, "SGD");
  async function save() {
    if (minor == null || minor <= 0) return;
    setBusy(true);
    try {
      await api.putIncomeBase({ base_takehome_minor: minor });
      invalidateAll();
      toast({ msg: "Take-home saved" });
      onClose();
    } catch (e) {
      toast({ msg: `Couldn't save: ${errMsg(e)}` });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet open onClose={onClose} title="Monthly take-home">
      <div className="space-y-3 px-5 pb-5 pt-3">
        <label className="block text-sm">
          <span className="block pb-1 font-medium">Take-home, after CPF (S$ a month)</span>
          <input className={`${field} num`} inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} placeholder="e.g. 4500" autoFocus />
        </label>
        <p className="text-xs text-muted">Your plan is built on base pay only. Commission and bonuses are logged separately when they arrive.</p>
        <button className={primaryBtn} disabled={busy || minor == null || minor <= 0} onClick={() => void save()}>Save</button>
      </div>
    </Sheet>
  );
}

const KINDS: { id: IncomeKind; label: string }[] = [{ id: "commission", label: "Commission" }, { id: "bonus", label: "Bonus" }, { id: "other", label: "Other" }];

/** Log commission, a bonus or other income: commission and bonus propose a split to confirm. */
export function LogIncomeSheet({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const today = sgtDate(new Date());
  const [kind, setKind] = useState<IncomeKind>("commission");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(today);
  const [busy, setBusy] = useState(false);
  const minor = parseMoneyInput(amount, "SGD");
  async function save() {
    if (minor == null || minor <= 0) return;
    setBusy(true);
    try {
      await api.addIncomeEvent({ kind, amount_minor: minor, received_on: date || undefined });
      invalidateAll();
      toast({ msg: kind === "other" ? "Logged" : "Logged. Your suggested split is ready to confirm." });
      onClose();
    } catch (e) {
      toast({ msg: `Couldn't log it: ${errMsg(e)}` });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet open onClose={onClose} title="Log commission">
      <div className="space-y-3 px-5 pb-5 pt-3">
        <div className="grid grid-cols-3 gap-1 rounded-full bg-bg p-1" role="radiogroup" aria-label="Kind">
          {KINDS.map((k) => (
            <button key={k.id} role="radio" aria-checked={kind === k.id} onClick={() => setKind(k.id)}
              className={`tap rounded-full text-[13px] font-extrabold ${kind === k.id ? "bg-accent text-accent-fg" : "text-muted"}`}>{k.label}</button>
          ))}
        </div>
        <label className="block text-sm">
          <span className="block pb-1 font-medium">Amount (S$)</span>
          <input className={`${field} num`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 1000" autoFocus />
        </label>
        <label className="block text-sm">
          <span className="block pb-1 font-medium">Received on</span>
          <input type="date" className={field} value={date} max={today} onChange={(e) => setDate(e.target.value)} />
        </label>
        <p className="text-xs text-muted">It never raises your regular Lifestyle budget. Okanary suggests a split and you confirm it.</p>
        <button className={primaryBtn} disabled={busy || minor == null || minor <= 0} onClick={() => void save()}>Log it</button>
      </div>
    </Sheet>
  );
}

/** Fixed-cost lines: change an amount, reset it to its baseline, or add a line (e.g. rent). */
export function FixedLinesSheet({ lines, overrides, onClose }: { lines: FixedLine[]; overrides: Record<string, number>; onClose: () => void }) {
  const toast = useToast();
  const [edits, setEdits] = useState<Record<string, string>>(() => Object.fromEntries(lines.map((l) => [l.key, minorToDecimalString(l.amount, "SGD")])));
  const [resets, setResets] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState<{ key: string; amount: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const toggleReset = (key: string) => setResets((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });

  async function save() {
    const parsed: Record<string, number | null> = {};
    for (const l of lines) parsed[l.key] = parseMoneyInput(edits[l.key] ?? "", "SGD");
    const next = applyOverrideEdits(overrides, lines, parsed, resets, added.map((a) => ({ key: a.key, amount: parseMoneyInput(a.amount, "SGD") })));
    setBusy(true);
    try {
      await api.putPlanSettings({ overrides: next });
      invalidateAll();
      toast({ msg: "Fixed costs updated" });
      onClose();
    } catch (e) {
      toast({ msg: `Couldn't save: ${errMsg(e)}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open onClose={onClose} title="Fixed costs">
      <div className="space-y-2 px-5 pb-5 pt-3">
        <p className="text-xs text-muted">Starts from your subscriptions and your usual Essentials spending. Change a line if you know better, like rent.</p>
        {lines.map((l) => {
          const reset = resets.has(l.key);
          return (
            <div key={l.key} className="flex items-center gap-2">
              <label className="min-w-0 flex-1 text-sm">
                <span className="block truncate pb-0.5 text-[13px] font-medium">{l.label}{l.overridden && !reset ? <span className="text-xs font-normal text-muted"> · set by you</span> : null}</span>
                <input className={`${field} num`} inputMode="decimal" disabled={reset} value={reset ? "" : edits[l.key] ?? ""} placeholder={reset ? "back to baseline" : undefined}
                  onChange={(e) => setEdits({ ...edits, [l.key]: e.target.value })} aria-label={`${l.label} per month`} />
              </label>
              {l.overridden && (
                <button className="tap mt-5 px-2 text-xs font-bold text-accent" onClick={() => toggleReset(l.key)}>{reset ? "Undo" : "Reset"}</button>
              )}
            </div>
          );
        })}
        {added.map((a, i) => (
          <div key={i} className="flex items-end gap-2">
            <label className="min-w-0 flex-1 text-sm"><span className="block pb-0.5 text-[13px] font-medium">Name</span>
              <input className={field} value={a.key} maxLength={64} placeholder="e.g. Rent" onChange={(e) => setAdded(added.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} /></label>
            <label className="w-28 text-sm"><span className="block pb-0.5 text-[13px] font-medium">S$ / month</span>
              <input className={`${field} num`} inputMode="decimal" value={a.amount} onChange={(e) => setAdded(added.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} /></label>
            <button className="tap px-1 text-muted" aria-label="Remove this line" onClick={() => setAdded(added.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
        <button className={softBtn} onClick={() => setAdded([...added, { key: "", amount: "" }])}>Add a line</button>
        <p className="text-xs text-muted">Reset puts a line back to its baseline, or removes a line you added.</p>
        <button className={primaryBtn} disabled={busy} onClick={() => void save()}>Save</button>
      </div>
    </Sheet>
  );
}

/** Lifestyle floor: the least Lifestyle the plan treats as realistic. Blank = the default share of your usual. */
export function PlanSettingsSheet({ floorOverride, floorPct, onClose }: { floorOverride: number | null; floorPct: number; onClose: () => void }) {
  const toast = useToast();
  const [v, setV] = useState(floorOverride != null ? minorToDecimalString(floorOverride, "SGD") : "");
  const [busy, setBusy] = useState(false);
  const minor = parseMoneyInput(v, "SGD");
  const valid = v.trim() === "" || minor != null;
  async function save(value: number | null) {
    setBusy(true);
    try {
      await api.putPlanSettings({ lifestyle_floor_minor: value });
      invalidateAll();
      toast({ msg: value == null ? `Back to ${floorPct}% of your usual` : "Floor saved" });
      onClose();
    } catch (e) {
      toast({ msg: `Couldn't save: ${errMsg(e)}` });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet open onClose={onClose} title="Lifestyle floor">
      <div className="space-y-3 px-5 pb-5 pt-3">
        <label className="block text-sm">
          <span className="block pb-1 font-medium">Least Lifestyle per month that feels realistic (S$)</span>
          <input className={`${field} num`} inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} placeholder={`blank = ${floorPct}% of your usual`} autoFocus />
        </label>
        <p className="text-xs text-muted">If goals and fixed costs leave less than this, the plan shows options instead of squeezing Lifestyle.</p>
        <button className={primaryBtn} disabled={busy || !valid} onClick={() => void save(v.trim() === "" ? null : minor)}>Save</button>
        {floorOverride != null && <button className={`${softBtn} w-full`} disabled={busy} onClick={() => void save(null)}>Use the default ({floorPct}% of your usual)</button>}
      </div>
    </Sheet>
  );
}

/** Commission split rule: three whole percents that must add up to 100. */
export function SplitRuleSheet({ rule, onClose }: { rule: SplitRule; onClose: () => void }) {
  const toast = useToast();
  const [p, setP] = useState<SplitPercents>(() => splitRuleToPercents(rule));
  const [busy, setBusy] = useState(false);
  const total = splitPercentsTotal(p);
  const next = splitRuleFromPercents(p);
  const rows: { key: keyof SplitPercents; label: string; hint: string }[] = [
    { key: "goals", label: "To goals", hint: "Goes to your goals in priority order, the ones behind first." },
    { key: "fun", label: "Guilt-free", hint: "Added to this week's Lifestyle allowance, spendable right away." },
    { key: "buffer", label: "Buffer", hint: "Tops up your emergency fund; once it's full, it goes to goals." },
  ];
  async function save() {
    if (!next) return;
    setBusy(true);
    try {
      await api.putSplitRule(next);
      invalidateAll();
      toast({ msg: "Commission split saved" });
      onClose();
    } catch (e) {
      toast({ msg: `Couldn't save: ${errMsg(e)}` });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet open onClose={onClose} title="Commission split">
      <div className="space-y-3 px-5 pb-5 pt-3">
        <p className="text-xs text-muted">When commission arrives, Okanary suggests this split and you confirm it. Some of it is meant for enjoying, because a plan with nothing for fun is hard to keep.</p>
        {rows.map((r) => (
          <label key={r.key} className="block text-sm">
            <span className="block pb-0.5 font-medium">{r.label} (%)</span>
            <input className={`${field} num`} inputMode="numeric" value={p[r.key]} onChange={(e) => setP({ ...p, [r.key]: e.target.value })} />
            <span className="block pt-0.5 text-xs text-muted">{r.hint}</span>
          </label>
        ))}
        <p className={`num text-sm ${next ? "text-good" : "text-lifestyle-ink"}`} role="status">Total {total}%{next ? "" : " · needs to be exactly 100%, in whole numbers"}</p>
        <button className={primaryBtn} disabled={busy || !next} onClick={() => void save()}>Save</button>
        <button className={`${softBtn} w-full`} disabled={busy} onClick={() => setP(DEFAULT_SPLIT_PERCENTS)}>Reset to 70 / 20 / 10</button>
      </div>
    </Sheet>
  );
}
