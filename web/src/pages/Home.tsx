import { useMemo, useState } from "react";
import { api, type TxnRowData } from "../lib/api";
import { useResource } from "../lib/data";
import { monthLabel, sgd } from "../lib/format";
import { useRefData } from "../lib/refdata";
import { currentMonth } from "../lib/month";
import { EditTxnSheet } from "../components/EditTxnSheet";
import { groupColor } from "../components/groups";
import { TxnRow } from "../components/TxnRow";

export function Home() {
  const month = currentMonth();
  const ref = useRefData();
  const summary = useResource(`summary:${month}`, () => api.summary(month));
  const recent = useResource("recent", () => api.transactions({ limit: 5 }));
  const [editing, setEditing] = useState<TxnRowData | null>(null);
  const s = summary.data;

  const g = useMemo(() => {
    const spend = new Map((s?.byGroup ?? []).map((b) => [b.id, b.spent]));
    const non = new Map((s?.byGroupNonSpend ?? []).map((b) => [b.id, b.spent]));
    return { essentials: spend.get("essentials") ?? 0, lifestyle: spend.get("lifestyle") ?? 0, savings: non.get("savings") ?? 0, uncategorised: spend.get("uncategorised") ?? 0 };
  }, [s]);

  if (summary.error && !s) return <p className="p-6 text-danger">Couldn't load: {summary.error}</p>;
  const delta = s ? s.total - s.totalLastMonthToDate : 0;
  const barMax = Math.max(g.essentials, g.lifestyle, g.savings, 1);
  const lifestyleShare = s && s.total > 0 ? Math.round((g.lifestyle * 100) / s.total) : 0;

  return (
    <div className="px-4 pt-safe">
      <header className="pb-1 pt-4">
        <p className="text-sm text-muted">{monthLabel(month)} · day {s?.day ?? "–"} of {s?.daysInMonth ?? "–"}</p>
        <h1 className="mt-1 text-sm font-medium text-muted">Spent this month</h1>
        <p className="num text-[44px] font-bold leading-tight tracking-tight">{s ? sgd(s.total) : "…"}</p>
        {s && s.totalLastMonthToDate > 0 && (
          <p className={`text-sm ${delta > 0 ? "text-danger" : "text-savings"}`}>
            {delta === 0 ? "Same as" : `${sgd(Math.abs(delta))} ${delta > 0 ? "more" : "less"} than`} this day last month
          </p>
        )}
      </header>

      <section className="mt-4 rounded-3xl bg-card p-4 shadow-sm" aria-label="Lifestyle">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold" style={{ color: "var(--lifestyle)" }}>Lifestyle</h2>
          <span className="text-xs text-muted">{lifestyleShare}% of spend</span>
        </div>
        <p className="num mt-1 text-3xl font-bold">{sgd(g.lifestyle)}</p>
        <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={lifestyleShare} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full rounded-full" style={{ width: `${Math.min(100, lifestyleShare)}%`, background: "var(--lifestyle)" }} />
        </div>
      </section>

      <section className="mt-3 space-y-2.5 rounded-3xl bg-card p-4 shadow-sm" aria-label="Groups">
        {([["essentials", "Essentials", g.essentials], ["lifestyle", "Lifestyle", g.lifestyle], ["savings", "Savings", g.savings]] as const).map(([id, name, v]) => (
          <div key={id}>
            <div className="flex justify-between text-sm"><span>{name}</span><span className="num font-medium">{sgd(v)}</span></div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full" style={{ width: `${(Math.max(v, 0) * 100) / barMax}%`, background: groupColor(id) }} /></div>
          </div>
        ))}
        {g.uncategorised > 0 && <p className="pt-1 text-xs text-muted">Plus {sgd(g.uncategorised)} uncategorised</p>}
      </section>

      <section className="mb-6 mt-4" aria-label="Recent">
        <h2 className="px-1 pb-1 text-sm font-semibold text-muted">Latest</h2>
        <div className="overflow-hidden rounded-3xl bg-card shadow-sm">
          {(recent.data ?? []).length === 0 && <p className="p-5 text-center text-sm text-muted">No transactions yet. Tap + to add your first.</p>}
          {(recent.data ?? []).map((t) => (
            <TxnRow key={t.id} t={t} categories={ref.categoryMap} accounts={ref.accountMap} onClick={() => setEditing(t)} />
          ))}
        </div>
      </section>
      <EditTxnSheet txn={editing} onClose={() => setEditing(null)} groups={ref.groups} categories={ref.categories} accounts={ref.accounts} />
    </div>
  );
}

