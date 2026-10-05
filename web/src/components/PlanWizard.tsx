import { useState } from "react";
import { Link } from "react-router-dom";
import { minorToDecimalString } from "@okanary/core";
import { api, type PlanResponse } from "../lib/api";
import { invalidateAll, useResource } from "../lib/data";
import { sgd } from "../lib/format";
import { emergencySuggestionText, monthYear } from "../lib/goals";
import { parseMoneyInput } from "../lib/networth";
import { canAdvance, infeasibleText, lifestyleText, nextStep, prevStep, wizardStartStep, WIZARD_STEPS, WIZARD_TITLES, type WizardStep } from "../lib/plan";
import { candidateText, groupSubscriptions } from "../lib/subscriptions";
import { GoalEditor } from "./GoalEditor";
import { Card, FixedLinesSheet, SplitBar, TradeOffCards, errMsg, field, primaryBtn, softBtn, useAcceptPlan } from "./PlanBits";
import { useToast } from "./Toast";

/**
 * First-open onboarding for the Plan tab: take-home → fixed costs → goals → see the plan → use it.
 * Skippable at any step; `onFinish` fires once with how it ended.
 */
export function PlanWizard({ data, month, onFinish }: { data: PlanResponse; month: string; onFinish: (how: "done" | "skipped") => void }) {
  const toast = useToast();
  const income = useResource("income", api.income);
  const subs = useResource("subscriptions", api.subscriptions);
  const goals = useResource("goals", api.goals);
  const suggestion = useResource("goals:emergency", api.emergencySuggestion).data;
  const { accept, busy: accepting } = useAcceptPlan(month);

  const [step, setStep] = useState<WizardStep>(() => wizardStartStep({ needsIncome: !!data.needs_income }));
  const base = income.data?.base?.base_takehome_minor ?? null;
  const [takeHome, setTakeHome] = useState<string | null>(null); // null = untouched, show the stored value
  const [busy, setBusy] = useState(false);
  const [editingFixed, setEditingFixed] = useState(false);
  const [addingGoal, setAddingGoal] = useState(false);

  const typed = takeHome ?? (base != null ? minorToDecimalString(base, "SGD") : "");
  const typedMinor = parseMoneyInput(typed, "SGD");
  const incomeSet = typedMinor != null && typedMinor > 0;

  async function next() {
    if (step === 1 && typedMinor != null && typedMinor > 0 && typedMinor !== base) {
      setBusy(true);
      try {
        await api.putIncomeBase({ base_takehome_minor: typedMinor });
        invalidateAll();
      } catch (e) {
        toast({ msg: `Couldn't save: ${errMsg(e)}` });
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    setStep(nextStep(step));
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

  async function finish(extend = false) {
    if (await accept(extend)) onFinish("done");
  }

  const full = data.needs_income ? null : data;
  const goalList = goals.data?.goals ?? [];
  const candidates = subs.data ? groupSubscriptions(subs.data.items).candidate : [];
  const showSuggestion = !!goals.data && !goalList.some((g) => g.kind === "emergency") && suggestion?.target != null && suggestion.target > 0 && suggestion.months.length > 0;

  async function answer(id: string, yes: boolean) {
    try {
      await (yes ? api.confirmSubscription(id) : api.dismissSubscription(id));
      invalidateAll();
    } catch (e) {
      toast({ msg: `Couldn't update it: ${errMsg(e)}` });
    }
  }

  return (
    <div className="pb-4">
      <div className="flex items-center justify-between gap-2 px-1 pt-4">
        <h1 className="text-lg font-extrabold">Set up your plan</h1>
        <button className="tap px-2 text-xs font-bold text-muted" onClick={() => onFinish("skipped")}>Skip for now</button>
      </div>
      <div className="flex items-center gap-1.5 px-1 pt-1" role="group" aria-label={`Step ${step} of ${WIZARD_STEPS}`}>
        {Array.from({ length: WIZARD_STEPS }, (_, i) => (
          <span key={i} aria-hidden className={`h-2 rounded-full ${i + 1 === step ? "w-5 bg-accent" : i + 1 < step ? "w-2 bg-accent/50" : "w-2 bg-line"}`} />
        ))}
        <span className="pl-2 text-xs text-muted">{step} of {WIZARD_STEPS} · {WIZARD_TITLES[step]}</span>
      </div>

      {step === 1 && (
        <Card title="What lands in your account each month?">
          <label className="block text-sm">
            <span className="block pb-1 font-medium">Take-home, after CPF (S$ a month)</span>
            <input className={`${field} num`} inputMode="decimal" value={typed} onChange={(e) => setTakeHome(e.target.value)} placeholder="e.g. 4500" />
          </label>
          <p className="pt-2 text-xs text-muted">Base pay only. Okanary plans on this steady number and treats commission as a bonus when it arrives.</p>
        </Card>
      )}

      {step === 2 && (
        <>
          {candidates.length > 0 && (
            <Card title="Charges that look like they repeat">
              <div className="space-y-3">
                {candidates.map((s) => (
                  <div key={s.id}>
                    <p className="text-sm font-semibold">{candidateText(s)}</p>
                    <div className="mt-1.5 flex gap-2">
                      <button className="tap flex-1 rounded-xl bg-accent text-sm font-semibold text-accent-fg" onClick={() => void answer(s.id, true)}>Yes</button>
                      <button className="tap flex-1 rounded-xl border border-line text-sm font-medium" onClick={() => void answer(s.id, false)}>Not one</button>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
          <Card title="Fixed costs each month" right={full && <button className="tap px-2 text-xs font-bold text-accent" onClick={() => setEditingFixed(true)}>Edit</button>}>
            {!full && <p className="text-sm text-muted">…</p>}
            {full && (
              <>
                <ul className="space-y-1.5">
                  {full.plan.fixed.lines.map((l) => (
                    <li key={l.key} className="flex justify-between gap-2 text-sm"><span className="truncate">{l.label}{l.overridden ? <span className="text-xs text-muted"> · set by you</span> : null}</span><span className="num">{sgd(l.amount)}</span></li>
                  ))}
                  {full.plan.fixed.lines.length === 0 && <li className="text-sm text-muted">Nothing detected yet. You can add a line, like rent.</li>}
                </ul>
                <p className="num mt-2 flex justify-between border-t border-line pt-2 text-sm font-bold"><span className="font-sans">Total</span><span>{sgd(full.plan.fixed.total)}</span></p>
                <p className="pt-1 text-xs text-muted">Subscriptions plus your usual Essentials spending. Add anything missing, like rent.</p>
              </>
            )}
          </Card>
        </>
      )}

      {step === 3 && (
        <>
          <Card title="Your goals">
            {goalList.length === 0 && <p className="text-sm text-muted">No goals yet. Goals with dates are what the plan works around.</p>}
            <ul className="space-y-1.5">
              {goalList.map((g) => (
                <li key={g.id} className="flex justify-between gap-2 text-sm">
                  <Link to={`/money/goals/${g.id}`} className="min-w-0 truncate font-medium">{g.emoji ? `${g.emoji} ` : ""}{g.name}</Link>
                  <span className="num shrink-0 text-xs text-muted">{sgd(g.target)}{g.target_date ? ` · ${monthYear(g.target_date)}` : ""}</span>
                </li>
              ))}
            </ul>
            <button className={`${softBtn} mt-3`} onClick={() => setAddingGoal(true)}>Add a goal</button>
          </Card>
          {showSuggestion && suggestion && (
            <Card>
              <p className="text-sm font-semibold">{emergencySuggestionText(suggestion.target!, suggestion.months.length)}</p>
              <p className="pt-1 text-xs text-muted">A buffer for surprises, funded from cash. Six months because part of your pay is commission.</p>
              <button className={`${softBtn} mt-2`} disabled={busy} onClick={() => void createEmergency()}>Add</button>
            </Card>
          )}
        </>
      )}

      {step === 4 && (
        <Card title="Your plan">
          {!full ? <p className="text-sm text-muted">…</p> : (
            <>
              <SplitBar plan={full.plan} />
              <p className="num pt-3 text-sm">{full.plan.splitText}</p>
              <p className="num pt-2 text-sm">Lifestyle: {lifestyleText(full.plan.lifestyle, month)}</p>
              {full.plan.feasible ? (
                <p className="pt-2 text-xs text-muted">Goals are on their dates and there's room left for Lifestyle.</p>
              ) : (
                <div className="space-y-2 pt-3">
                  <p className="text-xs text-lifestyle-ink">{infeasibleText(full.plan)}</p>
                  <TradeOffCards tradeOffs={full.plan.tradeOffs} busy={accepting} onUseDates={() => void finish(true)} />
                </div>
              )}
            </>
          )}
        </Card>
      )}

      {step === 5 && (
        <Card title="Ready when you are">
          {!full ? <p className="text-sm text-muted">…</p> : (
            <>
              <p className="text-sm">Using this plan sets your Lifestyle budget to <b className="num font-normal">{lifestyleText(full.plan.lifestyle, month)}</b> and gives each goal its monthly amount. You can change any of it later.</p>
              <button className={`${primaryBtn} mt-3`} disabled={accepting} onClick={() => void finish(false)}>Use this plan</button>
            </>
          )}
        </Card>
      )}

      <div className="mt-4 flex gap-2">
        {step > 1 && <button className={`${softBtn} flex-1`} onClick={() => setStep(prevStep(step))}>Back</button>}
        {step < WIZARD_STEPS && (
          <button className={`${primaryBtn} flex-1`} disabled={busy || !canAdvance(step, { incomeSet })} onClick={() => void next()}>Next</button>
        )}
      </div>

      {editingFixed && full && <FixedLinesSheet lines={full.plan.fixed.lines} overrides={full.inputs.overrides ?? {}} onClose={() => setEditingFixed(false)} />}
      {addingGoal && <GoalEditor goal={null} onClose={() => setAddingGoal(false)} />}
    </div>
  );
}
