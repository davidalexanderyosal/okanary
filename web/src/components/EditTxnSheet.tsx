import { useEffect, useState } from "react";
import { minorToDecimalString, parseMajorToMinor, sgtDate, sgtLocalToUtc, sgtParts, type Account, type Category, type CategoryGroup } from "@okanary/core";
import { api, type TxnRowData } from "../lib/api";
import { invalidateAll } from "../lib/data";
import { Sheet } from "./Sheet";
import { useToast } from "./Toast";

export function EditTxnSheet({ txn, onClose, groups, categories, accounts }: {
  txn: TxnRowData | null; onClose: () => void; groups: CategoryGroup[]; categories: Category[]; accounts: Account[];
}) {
  const toast = useToast();
  const [amount, setAmount] = useState("");
  const [merchant, setMerchant] = useState("");
  const [cat, setCat] = useState("");
  const [acct, setAcct] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [note, setNote] = useState("");
  const [refund, setRefund] = useState(false);
  const [reimb, setReimb] = useState(false);
  const [excl, setExcl] = useState(false);
  const [sgdAmount, setSgdAmount] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!txn) return;
    const p = sgtParts(txn.occurred_at);
    setAmount(minorToDecimalString(txn.amount_minor, txn.currency));
    setSgdAmount(minorToDecimalString(txn.amount_sgd_minor, "SGD"));
    setMerchant(txn.merchant ?? ""); setCat(txn.category_id ?? ""); setAcct(txn.account_id ?? "");
    setDate(sgtDate(txn.occurred_at)); setTime(`${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`);
    setNote(txn.note ?? ""); setRefund(!!txn.is_refund); setReimb(!!txn.is_reimbursable); setExcl(!!txn.is_excluded); setBusy(false);
  }, [txn]);

  if (!txn) return <Sheet open={false} onClose={onClose}>{null}</Sheet>;
  const foreign = txn.currency !== "SGD";

  async function save() {
    if (!txn) return;
    setBusy(true);
    try {
      const amount_minor = parseMajorToMinor(amount, txn.currency);
      await api.patchTxn(txn.id, {
        amount_minor, merchant: merchant.trim() || null, category_id: cat || null, account_id: acct || null,
        occurred_at: sgtLocalToUtc(date, time || "00:00"), note: note.trim() || null,
        is_refund: refund, is_reimbursable: reimb, is_excluded: excl,
        ...(foreign ? { amount_sgd_minor: parseMajorToMinor(sgdAmount, "SGD") } : {}),
      });
      invalidateAll();
      onClose();
    } catch (e) {
      setBusy(false);
      toast({ msg: `Couldn't save: ${e instanceof Error ? e.message : e}` });
    }
  }

  async function del() {
    if (!txn || !window.confirm("Delete this transaction?")) return;
    await api.deleteTxn(txn.id);
    invalidateAll();
    onClose();
  }

  const field = "tap w-full rounded-xl border border-line bg-bg px-3";
  return (
    <Sheet open onClose={onClose} title="Edit transaction">
      <div className="space-y-2 px-4 pb-4 pt-2">
        <label className="block text-xs text-muted">Amount ({txn.currency})
          <input inputMode="decimal" className={field} value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        {foreign && (
          <label className="block text-xs text-muted">Amount in SGD
            <input inputMode="decimal" className={field} value={sgdAmount} onChange={(e) => setSgdAmount(e.target.value)} />
          </label>
        )}
        <label className="block text-xs text-muted">Merchant
          <input className={field} value={merchant} onChange={(e) => setMerchant(e.target.value)} />
        </label>
        <label className="block text-xs text-muted">Category
          <select className={field} value={cat} onChange={(e) => setCat(e.target.value)}>
            <option value="">Uncategorised</option>
            {groups.map((g) => (
              <optgroup key={g.id} label={g.name}>
                {categories.filter((c) => c.group_id === g.id && (!c.archived || c.id === cat)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="block text-xs text-muted">Account
          <select className={field} value={acct} onChange={(e) => setAcct(e.target.value)}>
            <option value="">No account</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <div className="flex gap-2">
          <input type="date" className={field} value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
          <input type="time" className={`${field} w-32`} value={time} onChange={(e) => setTime(e.target.value)} aria-label="Time" />
        </div>
        <input className={field} placeholder="Note" value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="flex flex-wrap gap-4 py-1 text-sm">
          {([["Refund", refund, setRefund], ["Reimbursable", reimb, setReimb], ["Exclude", excl, setExcl]] as const).map(([label, v, set]) => (
            <label key={label} className="tap flex items-center gap-2"><input type="checkbox" className="h-5 w-5" checked={v} onChange={(e) => set(e.target.checked)} />{label}</label>
          ))}
        </div>
        <div className="flex gap-2 pt-1">
          <button onClick={() => void del()} className="tap rounded-xl border border-line px-4 font-medium text-danger">Delete</button>
          <button disabled={busy} onClick={() => void save()} className="tap flex-1 rounded-xl bg-accent font-semibold text-accent-fg disabled:opacity-50">Save</button>
        </div>
      </div>
    </Sheet>
  );
}
