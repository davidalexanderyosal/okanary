import { useEffect, useMemo, useRef, useState } from "react";
import { minorToDecimalString, sgtDate } from "@okanary/core";
import { api, type GoalKind, type GoalView, type FundingType } from "../lib/api";
import { invalidateAll, useResource } from "../lib/data";
import { sgd } from "../lib/format";
import { INFLATION_HINT, bpToPercent, defaultReturnPercent, fundingLinkText, inflates, percentToBp, previewTarget, retirementHelperText, warningText, type NameLookup } from "../lib/goals";
import { parseMoneyInput } from "../lib/networth";
import { Sheet } from "./Sheet";
import { useToast } from "./Toast";

const field = "tap w-full rounded-xl border border-line bg-bg px-3";
const primaryBtn = "tap flex-1 rounded-full bg-sun font-extrabold text-sun-fg shadow-[0_3px_0_var(--sun-edge)] active:translate-y-[3px] active:shadow-none disabled:opacity-50";
const softBtn = "tap rounded-full border-2 border-dashed border-lilac bg-card px-4 text-[13px] font-extrabold text-accent active:bg-line/40 disabled:opacity-50";
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const KINDS: { id: GoalKind; label: string }[] = [
  { id: "emergency", label: "Emergency fund" }, { id: "short", label: "Short term" }, { id: "mid", label: "Mid term" },
  { id: "long", label: "Long term" }, { id: "retirement", label: "Retirement" },
];
const EMOJIS = ["🛟", "🏖️", "✈️", "🎓", "💍", "🏠", "🚗", "🌴", "💻", "👶"];

/** Create or edit a goal. With `goal` null it creates; once created the sheet stays open so funding can be linked. */
export function GoalEditor({ goal, section, onClose, onArchived }: { goal: GoalView | null; section?: "funding"; onClose: () => void; onArchived?: () => void }) {
  const toast = useToast();
  const today = sgtDate(new Date());
  const [goalId, setGoalId] = useState<string | null>(goal?.id ?? null);
  const live = useResource("goals", api.goals).data?.goals.find((g) => g.id === goalId) ?? goal;

  const [name, setName] = useState(goal?.name ?? "");
  const [emoji, setEmoji] = useState(goal?.emoji ?? "");
  const [kind, setKind] = useState<GoalKind>(goal?.kind ?? "short");
  const [target, setTarget] = useState(goal ? minorToDecimalString(goal.target_today_minor, "SGD") : "");
  const [monthly, setMonthly] = useState("");
  const [date, setDate] = useState(goal?.target_date ?? "");
  const [inflation, setInflation] = useState(goal?.inflation_bp != null ? bpToPercent(goal.inflation_bp) : "");
  const [ret, setRet] = useState(goal && !goal.return_bp_is_default ? bpToPercent(goal.return_bp) : "");
  const [underspend, setUnderspend] = useState(goal?.receives_underspend ?? false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const fundingRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (section === "funding") fundingRef.current?.scrollIntoView({ block: "start" });
  }, [section]);

  const targetMinor = parseMoneyInput(target, "SGD");
  const monthlyMinor = parseMoneyInput(monthly, "SGD");
  const inflationBp = inflation.trim() === "" ? null : percentToBp(inflation);
  const needsDate = inflates(kind);
  const preview = useMemo(() => {
    if (targetMinor == null || targetMinor < 1) return null;
    return previewTarget({ kind, todayMinor: targetMinor, inflationBp: inflation.trim() === "" ? null : inflationBp, targetDate: date || null, today });
  }, [kind, targetMinor, inflation, inflationBp, date, today]);

  function fillFromMonthly(text: string) {
    setMonthly(text);
    const m = parseMoneyInput(text, "SGD");
    if (m != null && m > 0) setTarget(minorToDecimalString(m * 12 * 25, "SGD"));
  }

  function validate(): { input: Parameters<typeof api.createGoal>[0] } | string {
    if (!name.trim()) return "Give the goal a name.";
    if (targetMinor == null || targetMinor < 1) return "Enter a target amount above zero.";
    if (needsDate && !date) return "Pick a target date so today's amount can be inflated to then.";
    if (inflation.trim() !== "" && (inflationBp == null || inflationBp > 2000)) return "Inflation should be a percentage between 0 and 20, like 3 or 4.5.";
    const retBp = ret.trim() === "" ? null : percentToBp(ret);
    if (ret.trim() !== "" && (retBp == null || retBp > 3000)) return "Expected return should be a percentage between 0 and 30, like 4 or 6.5.";
    return {
      input: {
        name: name.trim(), emoji: emoji.trim() || null, kind, target_today_minor: targetMinor, target_date: date || null,
        inflation_bp: inflation.trim() === "" ? null : inflationBp, return_bp: retBp, receives_underspend: underspend,
      },
    };
  }

  async function save() {
    const v = validate();
    if (typeof v === "string") return setError(v);
    setError(null);
    setBusy(true);
    try {
      if (goalId) {
        const { receives_underspend: _ignored, ...patch } = v.input;
        await api.patchGoal(goalId, patch);
        invalidateAll();
        onClose();
      } else {
        const created = await api.createGoal(v.input);
        invalidateAll();
        setGoalId(created.id);
        toast({ msg: "Goal created. You can link funding below." });
        setBusy(false);
      }
    } catch (e) {
      setBusy(false);
      setError(`Couldn't save: ${errMsg(e)}`);
    }
  }

  async function toggleUnderspend(on: boolean) {
    setUnderspend(on);
    if (!goalId) return; // sent with the create
    try {
      await api.setGoalUnderspend(goalId, on);
      invalidateAll();
    } catch (e) {
      setUnderspend(!on);
      toast({ msg: `Couldn't change that: ${errMsg(e)}` });
    }
  }

  async function archive() {
    if (!goalId) return;
    setBusy(true);
    try {
      await api.archiveGoal(goalId);
      invalidateAll();
      toast({ msg: "Goal archived" });
      onClose();
      onArchived?.();
    } catch (e) {
      setBusy(false);
      toast({ msg: `Couldn't archive: ${errMsg(e)}` });
    }
  }

  return (
    <Sheet open onClose={onClose} title={goalId ? "Edit goal" : "New goal"}>
      <div className="space-y-2 px-4 pb-4 pt-2">
        <div className="flex gap-2">
          <label className="block w-20 shrink-0 text-xs text-muted">Emoji
            <input className={`${field} text-center`} value={emoji} maxLength={8} onChange={(e) => setEmoji(e.target.value)} placeholder="🎯" aria-label="Emoji" />
          </label>
          <label className="block min-w-0 flex-1 text-xs text-muted">Name
            <input className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Japan trip" />
          </label>
        </div>
        <div className="flex flex-wrap gap-1" aria-label="Emoji suggestions">
          {EMOJIS.map((e) => (
            <button key={e} type="button" className={`tap grid place-items-center rounded-full border text-lg ${emoji === e ? "border-accent bg-line/40" : "border-line bg-bg"}`} aria-label={`Use ${e}`} onClick={() => setEmoji(e)}>{e}</button>
          ))}
        </div>

        <label className="block text-xs text-muted">Type
          <select className={field} value={kind} onChange={(e) => setKind(e.target.value as GoalKind)}>
            {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
          </select>
        </label>

        {kind === "retirement" && (
          <div className="rounded-2xl bg-bg p-3">
            <label className="block text-xs text-muted">Desired monthly spending in retirement, in today's dollars (optional helper)
              <input className={field} inputMode="decimal" value={monthly} onChange={(e) => fillFromMonthly(e.target.value)} placeholder="e.g. 3000" />
            </label>
            {monthlyMinor != null && monthlyMinor > 0 && <p className="num mt-1 text-xs text-muted">{retirementHelperText(monthlyMinor)}</p>}
          </div>
        )}

        <label className="block text-xs text-muted">{needsDate ? "Target in today's dollars" : "Target amount"}
          <input className={field} inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="e.g. 5000" />
        </label>
        <label className="block text-xs text-muted">Target date{needsDate ? "" : " (optional)"}
          <input type="date" className={field} value={date} min={today} onChange={(e) => setDate(e.target.value)} />
        </label>
        {needsDate && preview?.text && <p className="num rounded-xl bg-bg px-3 py-2 text-sm" aria-live="polite">{preview.text}</p>}

        {needsDate && (
          <label className="block text-xs text-muted">Inflation per year, % (default 3)
            <input className={field} inputMode="decimal" value={inflation} onChange={(e) => setInflation(e.target.value)} placeholder="3" />
            <span className="mt-0.5 block text-[11px]">{INFLATION_HINT}</span>
          </label>
        )}
        <label className="block text-xs text-muted">Expected return per year, % (empty = default)
          <input className={field} inputMode="decimal" value={ret} onChange={(e) => setRet(e.target.value)} placeholder={defaultReturnPercent(kind, date || null, today)} />
          <span className="mt-0.5 block text-[11px]">Cash goals earn little, long-term investing more, but never a promise.</span>
        </label>

        <label className="tap flex items-center gap-2 text-sm">
          <input type="checkbox" className="h-5 w-5" checked={underspend} onChange={(e) => void toggleUnderspend(e.target.checked)} />
          Receives last week's underspend
        </label>

        {error && <p role="alert" className="px-1 text-xs font-semibold text-lifestyle-ink">{error}</p>}
        <div className="flex gap-2 pt-1">
          <button disabled={busy} onClick={() => void save()} className={primaryBtn}>{goalId ? "Save" : "Create goal"}</button>
        </div>

        <div ref={fundingRef} className="scroll-mt-2 pt-3">
          <h3 className="text-sm font-extrabold">Funding</h3>
          {goalId && live ? (
            <FundingSection goal={live} />
          ) : (
            <p className="pt-1 text-xs text-muted">Create the goal first, then link the accounts or holdings that fund it. Without links, the transfers you mark as moved count toward it.</p>
          )}
        </div>

        {goalId && (
          <div className="border-t border-dashed border-line pt-3">
            {confirmArchive ? (
              <div className="flex items-center gap-2">
                <p className="flex-1 text-xs text-muted">Archive this goal? It leaves your list and stops receiving pledges.</p>
                <button className={softBtn} onClick={() => setConfirmArchive(false)}>Keep</button>
                <button className={softBtn} disabled={busy} onClick={() => void archive()}>Archive</button>
              </div>
            ) : (
              <button className="tap text-xs font-bold text-muted underline" onClick={() => setConfirmArchive(true)}>Archive this goal</button>
            )}
          </div>
        )}
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ funding links

const ADD_TYPES: { id: FundingType; label: string }[] = [
  { id: "nw_account", label: "Share of an account" }, { id: "holding", label: "Share of a holding" }, { id: "earmark", label: "Earmark in a cash account" },
];

function FundingSection({ goal }: { goal: GoalView }) {
  const toast = useToast();
  const nw = useResource("networth", api.networth).data;
  const accounts = useMemo(() => (nw?.accounts ?? []).filter((a) => !a.archived && a.kind !== "liability"), [nw]);
  const holdings = nw?.holdings ?? [];
  const names: NameLookup = useMemo(() => ({
    account: (id) => nw?.accounts.find((a) => a.id === id)?.name,
    holding: (id) => nw?.holdings.find((h) => h.id === id)?.symbol,
  }), [nw]);

  const [type, setType] = useState<FundingType>("nw_account");
  const [source, setSource] = useState("");
  const [share, setShare] = useState("100");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options = type === "holding"
    ? holdings.map((h) => ({ id: h.id, label: `${h.symbol} (${accounts.find((a) => a.id === h.account_id)?.name ?? ""})` }))
    : (type === "earmark" ? accounts.filter((a) => a.kind === "cash") : accounts).map((a) => ({ id: a.id, label: a.name }));
  const chosen = options.some((o) => o.id === source) ? source : options[0]?.id ?? "";

  async function add() {
    if (!chosen) return setError("Add an account or holding in Net worth first.");
    let input: Parameters<typeof api.addGoalFunding>[1];
    if (type === "earmark") {
      const m = parseMoneyInput(amount, "SGD");
      if (m == null || m < 1) return setError("Enter the amount to set aside, above zero.");
      input = { source_type: "earmark", source_id: chosen, earmark_minor: m };
    } else {
      const bp = percentToBp(share);
      if (bp == null || bp < 1 || bp > 10000) return setError("Share should be a percentage between 0.01 and 100.");
      input = { source_type: type, source_id: chosen, share_bp: bp };
    }
    setError(null);
    setBusy(true);
    try {
      const r = await api.addGoalFunding(goal.id, input);
      invalidateAll();
      setAmount("");
      if (r.warnings.length > 0) toast({ msg: "Linked. Some funding is over-allocated, worth a look." });
    } catch (e) {
      setError(`Couldn't link: ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    try {
      await api.deleteGoalFunding(id);
      invalidateAll();
    } catch (e) {
      toast({ msg: `Couldn't remove: ${errMsg(e)}` });
    }
  }

  return (
    <div className="space-y-2 pt-1">
      {goal.funding.length === 0 && <p className="text-xs text-muted">Nothing linked yet. Without links, the transfers you mark as moved count toward this goal.</p>}
      {goal.funding.map((l) => (
        <div key={l.id} className="flex items-center justify-between gap-2 rounded-xl bg-bg px-3 py-1">
          <span className="num min-w-0 truncate text-sm">{fundingLinkText(l, names)}</span>
          <button className="tap shrink-0 px-2 text-xs font-bold text-muted underline" aria-label={`Remove ${fundingLinkText(l, names)}`} onClick={() => void remove(l.id)}>Remove</button>
        </div>
      ))}
      {goal.warnings.map((w, i) => <p key={i} className="rounded-xl border border-lifestyle bg-pill px-3 py-2 text-xs font-semibold text-lifestyle-ink">{warningText(w, names)}</p>)}

      <div className="space-y-2 rounded-2xl border border-dashed border-line p-3">
        <p className="text-xs font-bold text-muted">Link funding</p>
        <select className={field} value={type} onChange={(e) => { setType(e.target.value as FundingType); setSource(""); setError(null); }} aria-label="Kind of link">
          {ADD_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        <select className={field} value={chosen} onChange={(e) => setSource(e.target.value)} aria-label="Account or holding">
          {options.length === 0 && <option value="">Nothing to link yet</option>}
          {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
        {type === "earmark" ? (
          <label className="block text-xs text-muted">Amount to set aside
            <input className={field} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 1500" />
          </label>
        ) : (
          <label className="block text-xs text-muted">Share, %
            <input className={field} inputMode="decimal" value={share} onChange={(e) => setShare(e.target.value)} placeholder="100" />
          </label>
        )}
        {error && <p role="alert" className="text-xs font-semibold text-lifestyle-ink">{error}</p>}
        <button className={softBtn} disabled={busy || options.length === 0} onClick={() => void add()}>Add link</button>
        {goal.funding.some((l) => l.source_type === "earmark") && <p className="text-[11px] text-muted">Earmarked money stays in your account; it just counts toward this goal ({sgd(goal.value_parts.earmarked)} so far).</p>}
      </div>
    </div>
  );
}
