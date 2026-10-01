import { useMemo, useState } from "react";
import { addMonths, isSpend, sgtDate, signedSgdMinor } from "@okanary/core";
import { api, type TxnRowData } from "../lib/api";
import { useResource } from "../lib/data";
import { dayLabel, monthLabel, sgd } from "../lib/format";
import { currentMonth } from "../lib/month";
import { useRefData } from "../lib/refdata";
import { EditTxnSheet } from "../components/EditTxnSheet";
import { TxnRow } from "../components/TxnRow";

export function MonthStepper({ month, onChange }: { month: string; onChange: (m: string) => void }) {
  const cur = currentMonth();
  return (
    <div className="flex items-center justify-between">
      <button className="tap text-2xl" aria-label="Previous month" onClick={() => onChange(addMonths(month, -1))}>‹</button>
      <span className="font-semibold">{monthLabel(month)}</span>
      <button className="tap text-2xl disabled:opacity-30" aria-label="Next month" disabled={month >= cur} onClick={() => onChange(addMonths(month, 1))}>›</button>
    </div>
  );
}

export function Transactions() {
  const [month, setMonth] = useState(currentMonth());
  const [q, setQ] = useState("");
  const [group, setGroup] = useState("");
  const [editing, setEditing] = useState<TxnRowData | null>(null);
  const ref = useRefData();
  const list = useResource(`txns:${month}:${q}:${group}`, () => api.transactions({ month, q, group, limit: 500 }));
  const today = sgtDate(new Date());

  const days = useMemo(() => {
    const m = new Map<string, TxnRowData[]>();
    for (const t of list.data ?? []) {
      const d = sgtDate(t.occurred_at);
      (m.get(d) ?? m.set(d, []).get(d)!).push(t);
    }
    return [...m.entries()];
  }, [list.data]);

  return (
    <div className="px-4 pt-safe">
      <div className="pt-3"><MonthStepper month={month} onChange={setMonth} /></div>
      <input type="search" placeholder="Search merchant or note" value={q} onChange={(e) => setQ(e.target.value)} className="tap mt-2 w-full rounded-xl border border-line bg-card px-3" />
      <div className="-mx-4 mt-2 flex gap-2 overflow-x-auto px-4 pb-1">
        {[{ id: "", name: "All" }, ...ref.groups].map((g) => (
          <button key={g.id} onClick={() => setGroup(g.id)} className={`tap shrink-0 rounded-full border px-4 text-sm ${group === g.id ? "border-accent bg-accent text-accent-fg" : "border-line bg-card"}`}>{g.name}</button>
        ))}
      </div>
      <div className="mb-6 mt-2 space-y-3">
        {list.data && days.length === 0 && <p className="py-10 text-center text-sm text-muted">Nothing here.</p>}
        {days.map(([d, rows]) => {
          const total = rows.reduce((a, t) => a + (isSpend({ ...t, group_counts_as_spend: t.group_counts_as_spend }) ? signedSgdMinor(t) : 0), 0);
          return (
            <section key={d}>
              <div className="flex justify-between px-1 pb-1 text-xs font-semibold text-muted"><span>{dayLabel(rows[0]!.occurred_at, today)}</span><span className="num">{sgd(total)}</span></div>
              <div className="overflow-hidden rounded-3xl bg-card shadow-sm">
                {rows.map((t) => <TxnRow key={t.id} t={t} categories={ref.categoryMap} accounts={ref.accountMap} onClick={() => setEditing(t)} />)}
              </div>
            </section>
          );
        })}
      </div>
      <EditTxnSheet txn={editing} onClose={() => setEditing(null)} groups={ref.groups} categories={ref.categories} accounts={ref.accounts} />
    </div>
  );
}
