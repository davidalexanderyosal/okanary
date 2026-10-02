import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { paceFor, safeToSpendToday } from "@okanary/core";
import { api, type TxnRowData } from "../lib/api";
import { useResource } from "../lib/data";
import { monthLabel, sgd } from "../lib/format";
import { useRefData } from "../lib/refdata";
import { currentMonth } from "../lib/month";
import { EditTxnSheet } from "../components/EditTxnSheet";
import { groupColor } from "../components/groups";
import { Icon } from "../components/Icons";
import { Mascot } from "../components/Mascot";
import { ReceiptPaceBar, paceText, paceTextColor } from "../components/PaceBar";
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
  const lifeBudget = s?.budgets.find((b) => b.scope === "group" && b.ref_id === "lifestyle")?.monthly_amount_sgd_minor ?? 0;
  const pace = s && lifeBudget > 0 ? paceFor(g.lifestyle, lifeBudget, s.day, s.daysInMonth) : null;
  const safe = s && lifeBudget > 0 ? safeToSpendToday(lifeBudget, g.lifestyle, s.daysInMonth - s.day + 1) : null;
  const lifestyleShare = s && s.total > 0 ? Math.round((g.lifestyle * 100) / s.total) : 0;

  return (
    <div className="px-4 pt-safe">
      <header className="flex items-start justify-between gap-2 pb-1 pt-4">
        <div className="min-w-0">
          <p className="text-[13px] font-bold text-muted">{monthLabel(month)} · day {s?.day ?? "–"} of {s?.daysInMonth ?? "–"} · <span lang="ja">今月</span></p>
          <h1 className="mt-2.5 text-[13px] font-bold text-muted">Spent this month</h1>
          <p className="big-num text-[44px] leading-[1.05]" style={{ textShadow: "0 2px 0 var(--card)" }}>{s ? sgd(s.total) : "…"}</p>
          {s && s.totalLastMonthToDate > 0 && (
            <p className={`num mt-1 text-xs ${delta > 0 ? "text-danger" : "text-good"}`}>
              {delta === 0 ? "Same as" : `${sgd(Math.abs(delta))} ${delta > 0 ? "more" : "less"} than`} this day last month
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end">
          <Link to="/settings" aria-label="Settings" className="tap -mr-2 -mt-2 grid place-items-center text-muted active:text-fg"><Icon name="gear" className="h-[22px] w-[22px]" /></Link>
          <Mascot />
        </div>
      </header>

      {s && s.reviewCount > 0 && (
        <Link to="/review" className="tap mt-3.5 flex items-center justify-between rounded-full border-2 border-dashed border-lilac bg-card px-4 text-[13px] font-extrabold text-accent active:bg-line/40">
          <span>{s.reviewCount} to categorise</span><span aria-hidden>›</span>
        </Link>
      )}

      <Link to="/budgets" className="receipt relative mt-3 block rounded-[22px] bg-card p-4 shadow-sm active:bg-line/40" aria-label="Lifestyle">
        <span aria-hidden lang="ja" className="absolute right-4 top-[44px] grid h-10 w-10 -rotate-12 place-items-center rounded-full border-2 border-stamp text-xs font-extrabold leading-none text-stamp opacity-90">お金</span>
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-extrabold text-accent">Lifestyle</h2>
          {pace
            ? <span className={`rounded-full bg-pill px-2.5 py-0.5 text-[11px] font-extrabold ${paceTextColor[pace.state]}`}>{paceText[pace.state]}</span>
            : <span className="text-xs text-muted">{lifestyleShare}% of spend</span>}
        </div>
        <p className="num mt-1.5 pr-12 text-[30px] leading-[1.1] tracking-tight">
          {sgd(g.lifestyle)}
          {pace && <span className="text-[15px] text-muted"> / {sgd(lifeBudget)}</span>}
        </p>
        {pace && safe ? (
          <>
            <ReceiptPaceBar pace={pace} />
            <p className={`mt-4 rounded-full border-[1.5px] px-3 py-2 text-[13px] font-bold ${safe.exceeded ? "border-danger/50 bg-danger/10 text-danger" : "border-mint-line bg-mint-bg"}`}>
              {safe.exceeded
                ? <>Over budget by <span className="num text-base">{sgd(-safe.remaining)}</span></>
                : <>Safe to spend today <b className="num text-base font-normal">{sgd(safe.perDay)}</b> <span className="num text-[11px] font-medium text-muted">{sgd(safe.remaining)} over {safe.daysLeft} days</span></>}
            </p>
          </>
        ) : (
          <p className="mt-3 text-sm font-bold text-accent">Set a Lifestyle budget to see pace and safe-to-spend ›</p>
        )}
      </Link>

      <section className="mt-3 space-y-3 rounded-[22px] bg-card p-4 shadow-sm" aria-label="Groups">
        {([["essentials", "Essentials", g.essentials], ["lifestyle", "Lifestyle", g.lifestyle], ["savings", "Savings", g.savings]] as const).map(([id, name, v]) => (
          <div key={id}>
            <div className="flex justify-between text-[13px]"><span>{name}</span><span className="num text-sm">{sgd(v)}</span></div>
            <div className="mt-1 h-2.5 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full" style={{ width: `${(Math.max(v, 0) * 100) / barMax}%`, background: groupColor(id) }} /></div>
          </div>
        ))}
        {g.uncategorised > 0 && <p className="pt-1 text-xs text-muted">Plus <span className="num">{sgd(g.uncategorised)}</span> uncategorised</p>}
      </section>

      <section className="mb-6 mt-4" aria-label="Recent">
        <h2 className="px-1 pb-1.5 text-[13px] font-bold text-muted">Latest</h2>
        <div className="receipt overflow-visible rounded-[18px] bg-card shadow-sm">
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
