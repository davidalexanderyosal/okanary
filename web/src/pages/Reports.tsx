import { useState } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";
import { api } from "../lib/api";
import { useResource } from "../lib/data";
import { sgd } from "../lib/format";
import { currentMonth } from "../lib/month";
import { useRefData } from "../lib/refdata";
import { groupColor } from "../components/groups";
import { MonthStepper } from "./Transactions";

/** Phase 1: simple category breakdown (donut by group + ranked categories). Richer charts come in Phase 4. */
export function Reports() {
  const [month, setMonth] = useState(currentMonth());
  const ref = useRefData();
  const s = useResource(`summary:${month}`, () => api.summary(month)).data;
  const groupName = (id: string) => ref.groups.find((g) => g.id === id)?.name ?? "Uncategorised";
  const catName = (id: string) => ref.categoryMap.get(id)?.name ?? "Uncategorised";
  const groupOf = (id: string) => ref.categoryMap.get(id)?.group_id ?? "uncategorised";
  const pie = (s?.byGroup ?? []).filter((b) => b.spent > 0);
  const cats = (s?.byCategory ?? []).filter((b) => b.spent > 0);
  const max = Math.max(...cats.map((c) => c.spent), 1);

  return (
    <div className="px-4 pt-safe">
      <div className="pt-3"><MonthStepper month={month} onChange={setMonth} /></div>
      <p className="num mt-2 text-center text-3xl font-bold">{s ? sgd(s.total) : "…"}</p>
      <p className="text-center text-xs text-muted">total spend</p>

      {pie.length > 0 && (
        <div className="mt-2 h-52" aria-label="Spend by group">
          <ResponsiveContainer>
            <PieChart>
              <Pie data={pie} dataKey="spent" nameKey="id" innerRadius="58%" outerRadius="90%" paddingAngle={2} stroke="none">
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

      <section className="mb-6 mt-5 overflow-hidden rounded-3xl bg-card p-4 shadow-sm">
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
    </div>
  );
}
