import { useState } from "react";
import { addMonths, minorToDecimalString, paceFor, parseMajorToMinor, type BudgetRow } from "@okanary/core";
import { api, type Summary } from "../lib/api";
import { invalidateAll, useResource } from "../lib/data";
import { sgd } from "../lib/format";
import { currentMonth } from "../lib/month";
import { useRefData } from "../lib/refdata";
import { groupColor } from "../components/groups";
import { PaceBar, paceText, paceTextColor } from "../components/PaceBar";
import { useToast } from "../components/Toast";
import { MonthStepper } from "./Transactions";


function AmountEditor({ value, onSave }: { value: number; onSave: (minor: number) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const toast = useToast();
  if (!editing) {
    return (
      <button className="tap num rounded-xl border border-line px-3 text-sm font-semibold" onClick={() => { setText(value ? minorToDecimalString(value, "SGD").replace(/\.00$/, "") : ""); setEditing(true); }} aria-label="Edit budget">
        {value ? sgd(value) : "Set budget"}
      </button>
    );
  }
  async function commit() {
    try {
      await onSave(text.trim() === "" ? 0 : parseMajorToMinor(text, "SGD"));
      setEditing(false);
    } catch {
      toast({ msg: "Enter an amount like 900 or 900.50" });
    }
  }
  return (
    <span className="flex items-center gap-1">
      <input autoFocus inputMode="decimal" className="tap w-24 rounded-xl border border-accent bg-bg px-2 text-right" placeholder="0 = none" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void commit()} />
      <button className="tap rounded-xl bg-accent px-3 text-sm font-semibold text-accent-fg" onClick={() => void commit()}>OK</button>
    </span>
  );
}

function BudgetLine({ name, spent, budget, color, summary, onSave, small }: { name: string; spent: number; budget: number; color: string; summary: Summary; onSave: (m: number) => Promise<void>; small?: boolean }) {
  const pace = budget > 0 ? paceFor(spent, budget, summary.day, summary.daysInMonth) : null;
  return (
    <div className={small ? "py-2" : ""}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className={`truncate ${small ? "text-sm" : "font-semibold"}`}><span className="mr-2 inline-block h-2.5 w-2.5 rounded-full" style={{ background: color }} />{name}</p>
          <p className="num text-xs text-muted">{sgd(spent)} spent{pace ? <> · <span className={paceTextColor[pace.state]}>{paceText[pace.state]}</span></> : ""}</p>
        </div>
        <AmountEditor value={budget} onSave={onSave} />
      </div>
      {pace && <PaceBar pace={summary.day === summary.daysInMonth || summary.day === 0 ? { ...pace, pctExpected: 100 } : pace} color={color} />}
    </div>
  );
}

export function Budgets() {
  const [month, setMonth] = useState(currentMonth());
  const ref = useRefData();
  const toast = useToast();
  const summary = useResource(`summary:${month}`, () => api.summary(month)).data;
  const budgets = useResource(`budgets:${month}`, () => api.budgets(month)).data?.budgets ?? [];
  const find = (scope: BudgetRow["scope"], id: string) => budgets.find((b) => b.scope === scope && b.ref_id === id)?.monthly_amount_sgd_minor ?? 0;
  const spentG = (id: string) => summary?.byGroup.find((b) => b.id === id)?.spent ?? 0;
  const spentC = (id: string) => summary?.byCategory.find((b) => b.id === id)?.spent ?? 0;
  const save = (scope: BudgetRow["scope"], id: string) => async (minor: number) => { await api.putBudget({ scope, ref_id: id, month, amount_sgd_minor: minor }); invalidateAll(); };
  const spendGroups = ref.groups.filter((g) => g.counts_as_spend);
  const prev = addMonths(month, -1);

  return (
    <div className="px-4 pb-6 pt-safe">
      <div className="pt-3"><MonthStepper month={month} onChange={setMonth} allowFuture /></div>
      <button className="tap mt-2 w-full rounded-xl border border-line text-sm font-medium"
        onClick={() => void api.copyBudgets(prev, month).then((r) => { invalidateAll(); toast({ msg: r.copied ? `Copied ${r.copied} budgets from last month` : "Nothing to copy from last month" }); })}>
        Copy last month's budgets
      </button>
      <p className="px-1 pt-2 text-xs text-muted">A budget stays in force for later months until you change it. Enter 0 to clear it from this month on.</p>

      {summary && spendGroups.map((g) => (
        <section key={g.id} className="mt-3 rounded-3xl bg-card p-4 shadow-sm">
          <BudgetLine name={g.name} spent={spentG(g.id)} budget={find("group", g.id)} color={groupColor(g.id)} summary={summary} onSave={save("group", g.id)} />
          <div className="mt-2 divide-y divide-line border-t border-line">
            {ref.categories.filter((c) => c.group_id === g.id && !c.archived).map((c) => (
              <BudgetLine key={c.id} small name={c.name} spent={spentC(c.id)} budget={find("category", c.id)} color={groupColor(g.id)} summary={summary} onSave={save("category", c.id)} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
