import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, type PlanFull } from "../lib/api";
import { invalidateAll, useResource } from "../lib/data";
import { monthLabel, sgd } from "../lib/format";
import { currentMonth } from "../lib/month";
import {
  DISCLAIMER, acceptedText, budgetSourceNote, candidateLabel, capLine, capNote, commissionSplitText, commissionThisMonth, emergencyLine, eventLabel, floorLine, goalAssumptionText,
  infeasibleText, planMatchesAccepted, proposedEvents, readWizardDone, referenceText, splitRuleText, weeklyText, wizardShows, writeWizardDone,
} from "../lib/plan";
import { MoneyTabs } from "../components/MoneyTabs";
import {
  Card, FixedLinesSheet, IncomeBaseSheet, LogIncomeSheet, PlanSettingsSheet, SplitBar, SplitRuleSheet, TradeOffCards, errMsg, primaryBtn, softBtn, useAcceptPlan,
} from "../components/PlanBits";
import { PlanWizard } from "../components/PlanWizard";
import { SubscriptionsLink } from "../components/SubscriptionsLink";
import { useToast } from "../components/Toast";

type SheetName = "base" | "log" | "fixed" | "floor" | "split" | null;

/** Plan tab (v2 P): income, commission splits to confirm, the plan, trade-offs when it doesn't fit yet, assumptions. */
export function Plan() {
  const month = currentMonth();
  const plan = useResource(`plan:${month}`, () => api.plan(month));
  const [flagDone, setFlagDone] = useState(() => readWizardDone());
  const [dismissed, setDismissed] = useState(false);
  const p = plan.data;

  return (
    <div className="px-4 pb-6 pt-safe">
      <MoneyTabs />
      {!p && !plan.error && <p className="px-1 pt-10 text-center text-sm text-muted">…</p>}
      {!p && plan.error && <p className="px-1 pt-10 text-center text-sm text-muted">Couldn't load your plan just now. Try again in a moment.</p>}
      {p && (() => {
        const needsIncome = !!p.needs_income;
        const show = !dismissed && wizardShows({ needsIncome, hasAcceptedPlan: !needsIncome && !!p.accepted, flagDone });
        if (show) {
          return (
            <PlanWizard
              data={p} month={month}
              onFinish={(how) => { writeWizardDone(); setFlagDone(true); if (how === "skipped") setDismissed(true); }}
            />
          );
        }
        if (p.needs_income) {
          return (
            <Card>
              <p className="py-2 text-center text-sm text-muted">Add your monthly take-home and Okanary can work out a plan around your goals.</p>
              <div className="flex justify-center pb-1"><button className={softBtn} onClick={() => setDismissed(false)}>Set up your plan</button></div>
            </Card>
          );
        }
        return <PlanBody p={p} month={month} />;
      })()}
    </div>
  );
}

function PlanBody({ p, month }: { p: PlanFull; month: string }) {
  const toast = useToast();
  const income = useResource("income", api.income).data;
  const goals = useResource("goals", api.goals).data;
  const { accept, busy } = useAcceptPlan(month);
  const [sheet, setSheet] = useState<SheetName>(null);
  const [acting, setActing] = useState<string | null>(null);

  const plan = p.plan;
  const names = useMemo(() => new Map((goals?.goals ?? []).map((g) => [g.id, g.name])), [goals]);
  const nameOf = (id: string) => names.get(id) ?? p.inputs.goals.find((g) => g.id === id)?.name;
  const proposed = proposedEvents(income?.events ?? []);
  const commission = commissionThisMonth(income?.events ?? [], month);
  const note = budgetSourceNote(p.budget_source, p.lifestyle_budget, plan.lifestyle);
  const cap = capNote(plan, p.assumptions.cap_pct);
  const upToDate = !!p.accepted && p.budget_source === "plan" && planMatchesAccepted(plan, p.accepted.outputs);

  async function run(key: string, fn: () => Promise<unknown>, msg: string) {
    setActing(key);
    try {
      await fn();
      invalidateAll();
      toast({ msg });
    } catch (e) {
      toast({ msg: `Couldn't do that: ${errMsg(e)}` });
    } finally {
      setActing(null);
    }
  }

  return (
    <>
      <div className="flex items-baseline justify-between gap-2 px-1 pt-4">
        <h1 className="text-lg font-extrabold">Plan</h1>
        <span className="text-xs font-bold text-muted">{monthLabel(month)}</span>
      </div>

      <Card title="Income" right={<button className="tap px-2 text-xs font-bold text-accent" onClick={() => setSheet("base")}>Edit</button>}>
        <p className="num text-[26px] leading-tight tracking-tight">{income?.base ? sgd(income.base.base_takehome_minor) : sgd(plan.income)}<span className="text-sm text-muted"> /month</span></p>
        <p className="text-xs text-muted">Take-home, after CPF. Your plan is built on this.</p>
        <div className="mt-3 flex items-center justify-between gap-2 border-t border-line pt-3">
          <div className="min-w-0">
            <p className="text-[13px] font-semibold">Commission &amp; bonus this month</p>
            <p className="num text-sm">{sgd(commission)}</p>
          </div>
          <button className={`${softBtn} shrink-0 !min-h-9 text-xs`} onClick={() => setSheet("log")}>Log commission</button>
        </div>
        {income && (
          <div className="mt-2 flex items-center justify-between gap-2">
            <p className="num min-w-0 text-xs text-muted">{splitRuleText(income.split_rule)}</p>
            <button className="tap shrink-0 px-2 text-xs font-bold text-accent" onClick={() => setSheet("split")} aria-label="Edit the commission split">Edit</button>
          </div>
        )}
        {(income?.candidates ?? []).length > 0 && (
          <div className="mt-3 border-t border-line pt-3">
            <p className="pb-1.5 text-[13px] font-semibold">Income transactions to log</p>
            <div className="space-y-2">
              {income!.candidates.map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-2">
                  <span className="num min-w-0 truncate text-xs">{candidateLabel(c)}</span>
                  <button className="tap shrink-0 px-2 text-xs font-bold text-accent" disabled={acting === c.id}
                    onClick={() => void run(c.id, () => api.addIncomeEvent({ kind: "commission", amount_minor: c.amount_sgd_minor, transaction_id: c.id }), "Logged. Your suggested split is ready to confirm.")}>
                    Log as commission
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      {proposed.length > 0 && (
        <Card title="Commission splits to confirm">
          <div className="space-y-4">
            {proposed.map((e) => (
              <div key={e.id}>
                <p className="num text-sm font-semibold">{eventLabel(e)}</p>
                <p className="num pt-0.5 text-xs">{commissionSplitText(e.split!, nameOf)}</p>
                <div className="mt-2 flex gap-2">
                  <button className="tap flex-1 rounded-xl bg-accent text-sm font-semibold text-accent-fg disabled:opacity-50" disabled={acting === e.id}
                    onClick={() => void run(e.id, () => api.confirmIncomeEvent(e.id), "Confirmed. Pledges are waiting on the Goals tab.")}>Confirm</button>
                  <button className="tap flex-1 rounded-xl border border-line text-sm font-medium disabled:opacity-50" disabled={acting === e.id}
                    onClick={() => void run(e.id, () => api.skipIncomeEvent(e.id), "Skipped")}>Skip</button>
                </div>
                <button className="tap mt-1 px-1 text-xs text-muted underline disabled:opacity-50" disabled={acting === e.id}
                  onClick={() => { if (window.confirm(`Remove this ${e.kind} entry (${sgd(e.amount_minor)})? It was logged by mistake and its split goes away.`)) void run(e.id, () => api.deleteIncomeEvent(e.id), "Removed"); }}>Remove</button>
              </div>
            ))}
          </div>
          <p className="pt-2 text-xs text-muted">Okanary can't move money. Confirming adds pledges you transfer yourself.</p>
        </Card>
      )}

      <Card title="The plan">
        <SplitBar plan={plan} />
        <p className="num pt-3 text-sm">{plan.splitText}</p>
        <p className="pt-1 text-xs text-muted">{referenceText(p.references)}</p>
      </Card>

      {!plan.feasible && (
        <Card tint>
          <p className="text-sm font-bold text-lifestyle-ink">This doesn't fit yet</p>
          <p className="pb-3 pt-1 text-xs text-lifestyle-ink">{infeasibleText(plan)}</p>
          <TradeOffCards tradeOffs={plan.tradeOffs} busy={busy} onUseDates={() => void accept(true)} />
        </Card>
      )}

      <Card title="Fixed costs" right={<button className="tap px-2 text-xs font-bold text-accent" onClick={() => setSheet("fixed")}>Edit</button>}>
        <ul className="space-y-1.5">
          {plan.fixed.lines.map((l) => (
            <li key={l.key} className="flex justify-between gap-2 text-sm">
              <span className="min-w-0 truncate">{l.label}{l.overridden ? <span className="text-xs text-muted"> · set by you</span> : null}</span>
              <span className="num shrink-0">{sgd(l.amount)}</span>
            </li>
          ))}
          {plan.fixed.lines.length === 0 && <li className="text-sm text-muted">No fixed costs yet. Use Edit to add a line, like rent.</li>}
        </ul>
        <p className="num mt-2 flex justify-between border-t border-line pt-2 text-sm font-bold"><span className="font-sans">Total</span><span>{sgd(plan.fixed.total)}/mo</span></p>
        <SubscriptionsLink className="mt-3 !min-h-11" />
      </Card>

      <Card title="Goals, per month">
        {plan.goals.allocations.length === 0 && (
          <p className="text-sm text-muted">No goals yet. <Link to="/money/goals" className="font-bold text-accent">Add one</Link> and the plan works around it.</p>
        )}
        <ul className="space-y-2.5">
          {plan.goals.allocations.map((a) => (
            <li key={a.id}>
              <Link to={`/money/goals/${a.id}`} className="flex justify-between gap-2 text-sm">
                <span className="min-w-0 truncate font-medium">{a.name}</span>
                <span className="num shrink-0">{sgd(a.total)}/mo</span>
              </Link>
              <p className="num text-xs text-muted">{a.extra > 0 ? `${sgd(a.required)} needed + ${sgd(a.extra)} extra` : `${sgd(a.required)} needed`}</p>
            </li>
          ))}
        </ul>
        {plan.goals.allocations.length > 0 && <p className="num mt-2 flex justify-between border-t border-line pt-2 text-sm font-bold"><span className="font-sans">Total</span><span>{sgd(plan.goals.total)}/mo</span></p>}
      </Card>

      <Card title="Lifestyle">
        <p className="num text-[26px] leading-tight tracking-tight">{sgd(plan.lifestyle)}<span className="text-sm text-muted"> /month</span></p>
        <p className="num text-sm text-muted">{weeklyText(plan.lifestyle, month)} · your weekly allowance</p>
        {cap && <p className="pt-1 text-xs text-muted">{cap}</p>}
      </Card>

      <Card>
        {note && (
          <div className="mb-3">
            <p className="text-sm">{note}</p>
            <button className={`${softBtn} mt-2`} disabled={busy} onClick={() => void accept(false)}>Use the plan's number</button>
          </div>
        )}
        {!note && upToDate && p.accepted && (
          <p className="rounded-full border-[1.5px] border-mint-line bg-mint-bg px-3 py-2 text-[13px] font-bold">{acceptedText(p.accepted.outputs.lifestyle, month)}</p>
        )}
        {!note && !upToDate && (
          <>
            <button className={primaryBtn} disabled={busy} onClick={() => void accept(false)}>Use this plan</button>
            <p className="pt-2 text-center text-xs text-muted">Sets your Lifestyle budget to {sgd(plan.lifestyle)}/month and each goal's monthly amount.</p>
          </>
        )}
      </Card>

      <Card title="Assumptions">
        <ul className="space-y-2 text-sm">
          <li className="flex items-start justify-between gap-2">
            <span>{floorLine(plan, p.inputs.floorOverride, p.assumptions.floor_pct)}</span>
            <button className="tap shrink-0 px-2 text-xs font-bold text-accent" onClick={() => setSheet("floor")} aria-label="Edit the Lifestyle floor">Edit</button>
          </li>
          <li>{capLine(plan, p.assumptions.cap_pct)}</li>
          <li>{emergencyLine(p.assumptions.emergency_months)}</li>
          {p.assumptions.goals.map((g) => (
            <li key={g.id} className="flex items-start justify-between gap-2">
              <span>{goalAssumptionText(g)}</span>
              <Link to={`/money/goals/${g.id}`} className="tap shrink-0 px-2 text-xs font-bold text-accent" aria-label={`Edit ${g.name} assumptions`}>Edit</Link>
            </li>
          ))}
        </ul>
        <p className="pt-3 text-xs text-muted">{p.disclaimer || DISCLAIMER}</p>
      </Card>
      <p className="px-1 pt-4 text-center text-xs text-muted">{DISCLAIMER}</p>

      {sheet === "base" && <IncomeBaseSheet current={income?.base?.base_takehome_minor ?? plan.income} onClose={() => setSheet(null)} />}
      {sheet === "split" && income && <SplitRuleSheet rule={income.split_rule} onClose={() => setSheet(null)} />}
      {sheet === "log" && <LogIncomeSheet onClose={() => setSheet(null)} />}
      {sheet === "fixed" && <FixedLinesSheet lines={plan.fixed.lines} overrides={p.inputs.overrides ?? {}} onClose={() => setSheet(null)} />}
      {sheet === "floor" && <PlanSettingsSheet floorOverride={p.inputs.floorOverride ?? null} floorPct={p.assumptions.floor_pct} onClose={() => setSheet(null)} />}
    </>
  );
}
