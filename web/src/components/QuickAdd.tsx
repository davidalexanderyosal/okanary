import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { convertMinor, currencySymbol, formatMoney, parseMajorToMinor, sgtDate, sgtLocalToUtc, sgtParts, type Account, type Category, type CategoryGroup } from "@okanary/core";
import { api, type Trip } from "../lib/api";
import { invalidateAll, useResource } from "../lib/data";
import { chipOrder } from "../lib/chips";
import { displayTyped, keypadMinor, pressKey, type KeypadKey } from "../lib/keypad";
import { wantsAddLink } from "../lib/wants";
import { groupColor } from "./groups";
import { Sheet } from "./Sheet";
import { useToast } from "./Toast";

const KEYS: KeypadKey[] = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "back"];
const LS_ACCOUNT = "okanary.lastAccount";
const LS_CURRENCY = "okanary.currency";
const CURRENCIES = ["SGD", "IDR", "JPY", "USD", "MYR", "EUR", "GBP", "THB", "AUD", "KRW"];
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
  const navigate = useNavigate();
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
  const [currency, setCurrency] = useState(lsGet(LS_CURRENCY) ?? "SGD");
  const [pickCur, setPickCur] = useState(false);
  const [manualSgd, setManualSgd] = useState("");
  const [skipTrip, setSkipTrip] = useState(false);
  const trip = useResource<Trip | null>(open ? "trip:active" : "trip:none", () => (open ? api.activeTrip() : Promise.resolve(null))).data ?? null;
  const rate = useResource(`fx:${currency}:${open}`, () => (open && currency !== "SGD" ? api.fx(currency).catch(() => null) : Promise.resolve(null))).data ?? null;

  useEffect(() => {
    if (!open) return;
    const now = new Date();
    const p = sgtParts(now);
    setAmount(""); setMore(false); setCat(null); setMerchant(""); setNote("");
    setDate(sgtDate(now)); setTime(`${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`);
    setRefund(false); setReimb(false); setExcl(false); setBusy(false); setPickCur(false); setManualSgd(""); setSkipTrip(false);
    const last = lsGet(LS_ACCOUNT);
    setAccountId(last && accounts.some((a) => a.id === last) ? last : "");
  }, [open, accounts]);

  const minor = keypadMinor(amount, currency);
  const estimate = currency !== "SGD" && rate && minor > 0 ? convertMinor(minor, currency, "SGD", rate.rate) : null;
  const changeCurrency = (c: string) => { setCurrency(c); lsSet(LS_CURRENCY, c); setAmount(""); setPickCur(false); };
  const chips = useMemo(() => chipOrder(categories, groups, usage), [categories, groups, usage]);

  async function save(categoryId: string | null) {
    if (minor <= 0 || busy) return;
    setBusy(true);
    try {
      const t = await api.createTxn({
        amount_minor: minor, currency, category_id: categoryId,
        ...(currency !== "SGD" && manualSgd.trim() ? { amount_sgd_minor: parseMajorToMinor(manualSgd, "SGD") } : {}),
        ...(skipTrip ? { trip_id: null } : {}),
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
        msg: `Saved ${formatMoney(minor, currency)} · ${name}`,
        action: { label: "Undo", run: () => void api.deleteTxn(t.id).then(invalidateAll) },
      });
    } catch (e) {
      setBusy(false);
      toast({ msg: `Couldn't save: ${e instanceof Error ? e.message : e}` });
    }
  }

  /** "Want, not buy": hand the typed amount / currency / merchant to the want list instead of recording a purchase. */
  const wantInstead = () => {
    onClose();
    navigate(wantsAddLink({ amountMinor: minor, currency, name: merchant }));
  };

  const onChip = (id: string) => (more ? setCat(id) : void save(id));
  const disabled = minor <= 0;

  return (
    <Sheet open={open} onClose={onClose} title="Add expense">
      <div className="px-4 pb-3 pt-1">
        <div className="num mt-1 flex items-baseline justify-center gap-2 rounded-[20px] bg-bg pt-3 text-5xl tracking-tight shadow-[0_3px_0_var(--edge)]" aria-live="polite">
          <button className="tap rounded-xl text-2xl text-muted underline decoration-dotted underline-offset-4" onClick={() => setPickCur((p) => !p)} aria-label={`Currency ${currency}, tap to change`}>{currencySymbol(currency).trim()}</button>
          <span className={amount === "" ? "text-muted" : ""}>{displayTyped(amount)}</span>
        </div>
        <p className="num mt-1 h-6 text-center text-sm text-muted">
          {estimate !== null ? `≈ ${formatMoney(estimate, "SGD")}${rate ? ` at ${rate.rate}` : ""}` : currency !== "SGD" && minor > 0 && !rate ? "Rate unavailable: enter the SGD amount under More" : ""}
        </p>
        {pickCur && (
          <div className="-mx-1 mb-2 flex gap-2 overflow-x-auto px-1">
            {CURRENCIES.map((c) => (
              <button key={c} onClick={() => changeCurrency(c)} className={`tap shrink-0 rounded-full border px-3.5 text-sm font-medium ${c === currency ? "border-accent bg-accent text-accent-fg" : "border-line bg-bg"}`}>{c}</button>
            ))}
          </div>
        )}
        {trip?.currency && trip.currency !== currency && !pickCur && (
          <button className="tap mb-2 w-full rounded-xl bg-accent/15 text-sm font-medium text-accent" onClick={() => changeCurrency(trip.currency!)}>Traveling? Switch to {trip.currency} ({trip.name})</button>
        )}

        <div className="-mx-1 mb-3 flex max-h-[168px] flex-wrap content-start gap-2 overflow-y-auto px-1" aria-label="Categories">
          {chips.map((c) => (
            <button
              key={c.id}
              disabled={disabled || busy}
              onClick={() => onChip(c.id)}
              className={`tap flex items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium transition active:scale-95 disabled:opacity-40 ${cat === c.id ? "border-accent bg-accent text-accent-fg" : "border-dashed border-lilac bg-card"}`}
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
            {currency !== "SGD" && (
              <input inputMode="decimal" className="tap w-full rounded-xl border border-line bg-card px-3" placeholder={`Amount in SGD (optional${rate ? ", else ECB rate" : ", needed: no rate"})`} value={manualSgd} onChange={(e) => setManualSgd(e.target.value)} />
            )}
            {trip && <label className="tap flex items-center gap-2 text-sm"><input type="checkbox" className="h-5 w-5" checked={skipTrip} onChange={(e) => setSkipTrip(e.target.checked)} />Don't tag to "{trip.name}"</label>}
            <div className="flex flex-wrap gap-4 pt-1 text-sm">
              {([["Refund", refund, setRefund], ["Reimbursable", reimb, setReimb], ["Exclude", excl, setExcl]] as const).map(([label, v, set]) => (
                <label key={label} className="tap flex items-center gap-2"><input type="checkbox" className="h-5 w-5" checked={v} onChange={(e) => set(e.target.checked)} />{label}</label>
              ))}
            </div>
            <button disabled={disabled || busy} onClick={() => void save(cat)} className="tap w-full rounded-full bg-sun font-extrabold text-sun-fg shadow-[0_3px_0_var(--sun-edge)] active:translate-y-[3px] active:shadow-none disabled:opacity-40">
              Save{cat ? "" : " (uncategorised)"}
            </button>
          </div>
        )}

        <div className="grid grid-cols-3 gap-2">
          {KEYS.map((k) => (
            <button key={k} onClick={() => { navigator.vibrate?.(4); setAmount((s) => pressKey(s, k, currency)); }} onDoubleClick={() => k === "back" && setAmount("")}
              className="tap num h-[52px] rounded-2xl bg-bg text-2xl shadow-[0_3px_0_var(--edge)] active:translate-y-[3px] active:shadow-none" aria-label={k === "back" ? "Backspace" : k}>
              {k === "back" ? "⌫" : k}
            </button>
          ))}
        </div>
        <button onClick={() => setMore((m) => !m)} className="tap mt-2 w-full text-sm font-medium text-accent">
          {more ? "Fewer options" : "More: merchant, note, account, date…"}
        </button>
        <button onClick={wantInstead} className="tap w-full text-sm font-medium text-muted underline decoration-dotted underline-offset-4">
          Want, not buy
        </button>
      </div>
    </Sheet>
  );
}
