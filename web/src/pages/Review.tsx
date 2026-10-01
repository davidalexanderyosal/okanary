import { useRef, useState } from "react";
import { formatMoney, type Category } from "@okanary/core";
import { api, type DuplicateCard, type FailedRaw, type TxnRowData } from "../lib/api";
import { chipOrder } from "../lib/chips";
import { invalidateAll, useResource } from "../lib/data";
import { dayLabel, prettyMerchant, timeLabel } from "../lib/format";
import { offerRule } from "../lib/rules";
import { useRefData } from "../lib/refdata";
import { sgtDate } from "@okanary/core";
import { groupColor } from "../components/groups";
import { useToast } from "../components/Toast";

const SOURCE_ICON: Record<string, string> = { applepay: "", email: "✉", manual: "✎", import: "⇪" };

function ReviewCard({ t, chips, catName, onPick, onExclude, today }: { t: TxnRowData; chips: Category[]; catName: (id: string | null) => string; onPick: (c: Category) => void; onExclude: () => void; today: string }) {
  const [dx, setDx] = useState(0);
  const start = useRef<number | null>(null);
  const suggested = t.category_source === "ai" ? t.category_id : null;
  return (
    <div className="relative overflow-hidden rounded-3xl">
      <div className="absolute inset-0 flex items-center justify-end bg-danger/90 px-6 text-sm font-semibold text-white">Exclude</div>
      <article
        className="relative rounded-3xl bg-card p-4 shadow-sm transition-transform"
        style={{ transform: `translateX(${dx}px)`, transition: start.current === null ? "transform .2s" : "none" }}
        onTouchStart={(e) => (start.current = e.touches[0]!.clientX)}
        onTouchMove={(e) => start.current !== null && setDx(Math.min(0, e.touches[0]!.clientX - start.current))}
        onTouchEnd={() => { const swiped = dx < -110; start.current = null; setDx(0); if (swiped) onExclude(); }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate font-semibold">{prettyMerchant(t.merchant) || "Unknown merchant"}</p>
            <p className="text-xs text-muted">{SOURCE_ICON[t.source] ?? ""} {t.source} · {dayLabel(t.occurred_at, today)} {timeLabel(t.occurred_at)}{t.status === "pending" ? " · pending" : ""}</p>
          </div>
          <p className="num shrink-0 text-lg font-bold">{formatMoney(t.amount_minor, t.currency)}</p>
        </div>
        {t.note && <p className="mt-1 text-xs text-muted">{t.note}</p>}
        {suggested && <p className="mt-2 text-xs text-muted">Suggested: <b className="text-fg">{catName(suggested)}</b>, tap it to confirm</p>}
        <div className="mt-3 flex max-h-[132px] flex-wrap gap-2 overflow-y-auto">
          {chips.map((c) => (
            <button key={c.id} onClick={() => onPick(c)}
              className={`tap flex items-center gap-1.5 rounded-full border px-3 text-sm active:scale-95 ${suggested === c.id ? "border-accent bg-accent text-accent-fg" : "border-line bg-bg"}`}>
              <span className="h-2 w-2 rounded-full" style={{ background: groupColor(c.group_id) }} />{c.name}
            </button>
          ))}
        </div>
        <button onClick={onExclude} className="tap mt-2 text-sm text-muted underline">Exclude from spend</button>
      </article>
    </div>
  );
}

function FailedCard({ f }: { f: FailedRaw }) {
  return (
    <article className="rounded-3xl border border-danger/40 bg-card p-4">
      <p className="text-sm font-semibold text-danger">Couldn't read this {f.source} capture</p>
      <p className="text-xs text-muted">{f.error} · {f.received_at.slice(0, 16).replace("T", " ")} UTC</p>
      <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-bg p-2 text-xs">{(f.payload ?? "").slice(0, 1500)}</pre>
      <div className="mt-2 flex gap-3">
        <button className="tap text-sm font-medium text-accent" onClick={() => window.dispatchEvent(new Event("okanary:quickadd"))}>Add manually</button>
        <button className="tap text-sm text-muted" onClick={() => void api.dismissRaw(f.id).then(invalidateAll)}>Dismiss</button>
      </div>
    </article>
  );
}

function DuplicateCardView({ d, today }: { d: DuplicateCard; today: string }) {
  const toast = useToast();
  const side = (t: TxnRowData) => (
    <div className="min-w-0 flex-1 rounded-2xl bg-bg p-2.5">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">{t.source === "applepay" ? "Apple Pay" : t.source === "email" ? "Bank email" : t.source}</p>
      <p className="truncate text-sm font-medium">{prettyMerchant(t.merchant)}</p>
      <p className="num text-base font-bold">{formatMoney(t.amount_minor, t.currency)}</p>
      <p className="text-xs text-muted">{dayLabel(t.occurred_at, today)} {timeLabel(t.occurred_at)}</p>
    </div>
  );
  return (
    <article className="rounded-3xl border border-accent/40 bg-card p-4 shadow-sm">
      <p className="pb-2 text-sm font-semibold text-accent">Possible duplicate: merge?</p>
      <div className="flex gap-2">{side(d.other)}{side(d.txn)}</div>
      <p className="pt-2 text-xs text-muted">Merging keeps one record with the bank's amount and the Apple Pay time.</p>
      <div className="mt-2 flex gap-2">
        <button className="tap flex-1 rounded-xl bg-accent font-semibold text-accent-fg" onClick={() => void api.mergeDuplicate(d.id).then(() => { invalidateAll(); toast({ msg: "Merged into one transaction" }); })}>Merge</button>
        <button className="tap flex-1 rounded-xl border border-line" onClick={() => void api.dismissDuplicate(d.id).then(invalidateAll)}>Not a duplicate</button>
      </div>
    </article>
  );
}

export function Review() {
  const ref = useRefData();
  const toast = useToast();
  const data = useResource("review", api.review);
  const chips = chipOrder([...ref.categories], ref.groups, ref.usage);
  const catName = (id: string | null) => (id ? ref.categoryMap.get(id)?.name ?? "" : "");
  const today = sgtDate(new Date());
  const items = data.data?.items ?? [];
  const failed = data.data?.failed ?? [];
  const duplicates = data.data?.duplicates ?? [];

  async function pick(t: TxnRowData, c: Category) {
    await api.patchTxn(t.id, { category_id: c.id });
    invalidateAll();
    if (c.id !== t.category_id || t.category_source !== "ai") offerRule(toast, t, c.id, c.name);
  }
  async function exclude(t: TxnRowData) {
    await api.patchTxn(t.id, { is_excluded: true });
    invalidateAll();
    toast({ msg: "Excluded from spend", action: { label: "Undo", run: () => void api.patchTxn(t.id, { is_excluded: false }).then(invalidateAll) } });
  }

  return (
    <div className="px-4 pt-safe">
      <h1 className="pb-1 pt-4 text-2xl font-bold">To categorise</h1>
      <p className="pb-3 text-sm text-muted">One tap on a category. Auto-captured items land here until you confirm them.</p>
      <div className="mb-6 space-y-3">
        {data.data && items.length === 0 && failed.length === 0 && duplicates.length === 0 && <p className="py-12 text-center text-muted">All caught up ✓</p>}
        {duplicates.map((d) => <DuplicateCardView key={d.id} d={d} today={today} />)}
        {failed.map((f) => <FailedCard key={f.id} f={f} />)}
        {items.map((t) => <ReviewCard key={t.id} t={t} chips={chips} catName={catName} today={today} onPick={(c) => void pick(t, c)} onExclude={() => void exclude(t)} />)}
      </div>
    </div>
  );
}
