import { useEffect, useMemo, useState } from "react";
import { formatMoney, sgtDate, sgtLocalToUtc, sgtParts, type Account, type Category, type CategoryGroup } from "@okanary/core";
import { api } from "../lib/api";
import { invalidateAll } from "../lib/data";
import { displayTyped, keypadMinor, pressKey, type KeypadKey } from "../lib/keypad";
import { groupColor } from "./groups";
import { Sheet } from "./Sheet";
import { useToast } from "./Toast";

const KEYS: KeypadKey[] = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "back"];
const LS_ACCOUNT = "okanary.lastAccount";
const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

/**
 * Quick add = 3 taps: (1) "+" , (2) type the amount, (3) tap a category chip -> saved.
 * Opening "More" (merchant / note / account / date / flags) turns chips into a selection
 * and reveals an explicit Save button, so the fast path stays fast.
 */
export function QuickAdd({ open, onClose, groups, categories, usage, accounts }: {
  open: boolean; onClose: () => void; groups: CategoryGroup[]; categories: Category[]; usage: Record<string, number>; accounts: Account[];
}) {
  const toast = useToast();
  const [amount, setAmount] = useState("");
  const [more, setMore] = useState(false);
  const [cat, setCat] = useState<string | null>(null);
  const [merchant, setMerchant] = useState("");
  const [note, setNote] = useState("");
  const [accountId, setAccountId] = useState<string>("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [refund, setRefund] = useState(false);
  const [reimb, setReimb] = useState(false);
  const [excl, setExcl] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const now = new Date();
    const p = sgtParts(now);
    setAmount(""); setMore(false); setCat(null); setMerchant(""); setNote("");
    setDate(sgtDate(now)); setTime(`${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`);
    setRefund(false); setReimb(false); setExcl(false); setBusy(false);
    const last = lsGet(LS_ACCOUNT);
    setAccountId(last && accounts.some((a) => a.id === last) ? last : "");
  }, [open, accounts]);

  const minor = keypadMinor(amount, "SGD");
  const groupSort = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups]);
  const chips = useMemo(
    () =>
      categories
        .filter((c) => !c.archived)
        .sort((a, b) => {
          const ga = groupSort.get(a.group_id), gb = groupSort.get(b.group_id);
          // most-used first; ties: Lifestyle (the point of the app), other spend groups, then non-spend groups
          const rank = (g?: CategoryGroup) => (g?.id === "lifestyle" ? 0 : g?.counts_as_spend ? 1 : 2);
          return (usage[b.id] ?? 0) - (usage[a.id] ?? 0) || rank(ga) - rank(gb) || (ga?.sort ?? 0) - (gb?.sort ?? 0) || a.sort - b.sort;
        }),
    [categories, groupSort, usage],
  );

  async function save(categoryId: string | null) {
    if (minor <= 0 || busy) return;
    setBusy(true);
    try {
      const t = await api.createTxn({
        amount_minor: minor, currency: "SGD", category_id: categoryId,
        merchant: merchant.trim() || null, note: note.trim() || null, account_id: accountId || null,
        occurred_at: more && date ? sgtLocalToUtc(date, time || "00:00") : undefined,
        is_refund: refund, is_reimbursable: reimb, is_excluded: excl,
      });
      if (accountId) lsSet(LS_ACCOUNT, accountId);
      navigator.vibrate?.(10);
      invalidateAll();
      onClose();
      const name = categories.find((c) => c.id === categoryId)?.name ?? "Expense";
      toast({
        msg: `Saved ${formatMoney(minor, "SGD")} · ${name}`,
        action: { label: "Undo", run: () => void api.deleteTxn(t.id).then(invalidateAll) },
      });
    } catch (e) {
      setBusy(false);
      toast({ msg: `Couldn't save: ${e instanceof Error ? e.message : e}` });
    }
  }

  const onChip = (id: string) => (more ? setCat(id) : void save(id));
  const disabled = minor <= 0;

  return (
    <Sheet open={open} onClose={onClose} title="Add expense">
      <div className="px-4 pb-3 pt-1">
        <div className="num flex items-baseline justify-center gap-2 py-3 text-5xl font-semibold tracking-tight" aria-live="polite">
          <span className="text-2xl text-muted">S$</span>
          <span className={amount === "" ? "text-muted" : ""}>{displayTyped(amount)}</span>
        </div>

        <div className="-mx-1 mb-3 flex max-h-[168px] flex-wrap content-start gap-2 overflow-y-auto px-1" aria-label="Categories">
          {chips.map((c) => (
            <button
              key={c.id}
              disabled={disabled || busy}
              onClick={() => onChip(c.id)}
              className={`tap flex items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium transition active:scale-95 disabled:opacity-40 ${cat === c.id ? "border-accent bg-accent text-accent-fg" : "border-line bg-bg"}`}
            >
              <span className="h-2 w-2 rounded-full" style={{ background: groupColor(c.group_id) }} />
              {c.name}
            </button>
          ))}
        </div>

        {more && (
          <div className="mb-3 space-y-2 rounded-2xl bg-bg p-3">
            <input className="tap w-full rounded-xl border border-line bg-card px-3" placeholder="Merchant (optional)" value={merchant} onChange={(e) => setMerchant(e.target.value)} />
            <input className="tap w-full rounded-xl border border-line bg-card px-3" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
            <div className="flex gap-2">
              <select className="tap min-w-0 flex-1 rounded-xl border border-line bg-card px-2" value={accountId} onChange={(e) => setAccountId(e.target.value)} aria-label="Account">
                <option value="">No account</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div className="flex gap-2">
              <input type="date" className="tap min-w-0 flex-1 rounded-xl border border-line bg-card px-2" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
              <input type="time" className="tap w-28 rounded-xl border border-line bg-card px-2" value={time} onChange={(e) => setTime(e.target.value)} aria-label="Time" />
            </div>
            <div className="flex flex-wrap gap-4 pt-1 text-sm">
              {([["Refund", refund, setRefund], ["Reimbursable", reimb, setReimb], ["Exclude", excl, setExcl]] as const).map(([label, v, set]) => (
                <label key={label} className="tap flex items-center gap-2"><input type="checkbox" className="h-5 w-5" checked={v} onChange={(e) => set(e.target.checked)} />{label}</label>
              ))}
            </div>
            <button disabled={disabled || busy} onClick={() => void save(cat)} className="tap w-full rounded-xl bg-accent font-semibold text-accent-fg disabled:opacity-40">
              Save{cat ? "" : " (uncategorised)"}
            </button>
          </div>
        )}

        <div className="grid grid-cols-3 gap-2">
          {KEYS.map((k) => (
            <button key={k} onClick={() => { navigator.vibrate?.(4); setAmount((s) => pressKey(s, k, "SGD")); }} onDoubleClick={() => k === "back" && setAmount("")}
              className="tap h-[52px] rounded-2xl bg-bg text-2xl font-medium active:bg-line" aria-label={k === "back" ? "Backspace" : k}>
              {k === "back" ? "⌫" : k}
            </button>
          ))}
        </div>
        <button onClick={() => setMore((m) => !m)} className="tap mt-2 w-full text-sm font-medium text-accent">
          {more ? "Fewer options" : "More: merchant, note, account, date…"}
        </button>
      </div>
    </Sheet>
  );
}
