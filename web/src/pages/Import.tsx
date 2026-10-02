import { useState } from "react";
import { Link } from "react-router-dom";
import { api, type ImportResult } from "../lib/api";
import { invalidateAll } from "../lib/data";
import { prettyMerchant, sgd, shortDate } from "../lib/format";
import { useRefData } from "../lib/refdata";
import { useToast } from "../components/Toast";

/** Statement import & reconcile (spec §3.2): fills gaps and corrects final billed SGD amounts after FX fees. */
export function Import() {
  const ref = useRefData();
  const toast = useToast();
  const [account, setAccount] = useState("");
  const [text, setText] = useState("");
  const [res, setRes] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const cards = ref.accounts.filter((a) => a.kind === "credit" || a.kind === "debit");

  async function go(commit: boolean) {
    setBusy(true);
    try {
      const r = await api.importStatement({ account_id: account, text, commit });
      setRes(r);
      if (commit) { invalidateAll(); toast({ msg: `Applied: ${r.applied?.added ?? 0} added, ${r.applied?.corrected ?? 0} corrected` }); }
    } catch (e) {
      toast({ msg: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(false); }
  }

  const row = "flex items-start justify-between gap-3 py-1.5 text-sm";
  return (
    <div className="px-4 pb-8 pt-safe">
      <Link to="/settings" className="tap inline-flex items-center pt-3 text-sm text-accent">‹ Settings</Link>
      <h1 className="pb-1 text-2xl font-bold">Import a statement</h1>
      <p className="pb-3 text-sm text-muted">Pick the card, then paste the statement's CSV, or open the PDF, select all, copy and paste the text. You'll see exactly what changes before anything is saved.</p>

      <section className="space-y-2 rounded-3xl bg-card p-4 shadow-sm">
        <select className="tap w-full rounded-xl border border-line bg-bg px-3" value={account} onChange={(e) => { setAccount(e.target.value); setRes(null); }} aria-label="Card">
          <option value="">Choose a card…</option>
          {cards.map((a) => <option key={a.id} value={a.id}>{a.name}{a.last4 ? ` ····${a.last4}` : ""}</option>)}
        </select>
        <textarea className="min-h-40 w-full rounded-xl border border-line bg-bg p-3 font-mono text-xs" placeholder="Paste statement CSV or text here" value={text} onChange={(e) => { setText(e.target.value); setRes(null); }} />
        <div className="flex gap-2">
          <label className="tap flex cursor-pointer items-center rounded-xl border border-line px-4 text-sm font-medium">
            Choose file
            <input type="file" accept=".csv,.txt,text/csv,text/plain" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void f.text().then((t) => { setText(t); setRes(null); }); }} />
          </label>
          <button disabled={!account || !text.trim() || busy} onClick={() => void go(false)} className="tap flex-1 rounded-xl bg-accent font-semibold text-accent-fg disabled:opacity-40">Preview</button>
        </div>
      </section>

      {res && (
        <section className="mt-4 rounded-3xl bg-card p-4 shadow-sm">
          <h2 className="pb-1 text-sm font-semibold text-muted">{res.applied ? "Applied" : "Preview"} · read as {res.mode === "csv" ? "CSV" : "text"}{res.skipped ? ` · ${res.skipped} unreadable lines skipped` : ""}</h2>
          <p className="text-sm">
            <b>{res.matched.length}</b> already tracked · <b>{res.matched.filter((m) => m.correct_sgd_to !== null).length}</b> amounts corrected · <b>{res.to_add.length}</b> to add · <b>{res.payments.length}</b> payments ignored
          </p>

          {res.matched.some((m) => m.correct_sgd_to !== null) && <h3 className="pt-3 text-xs font-semibold uppercase tracking-wide text-muted">Amounts corrected to the billed SGD</h3>}
          {res.matched.filter((m) => m.correct_sgd_to !== null).map((m, i) => (
            <p key={i} className={row}><span className="min-w-0 truncate">{prettyMerchant(m.txn?.merchant) || m.description}</span><span className="num shrink-0 text-muted">{sgd(m.txn?.amount_sgd_minor ?? 0)} → <b className="text-fg">{sgd(m.correct_sgd_to!)}</b></span></p>
          ))}

          {res.to_add.length > 0 && <h3 className="pt-3 text-xs font-semibold uppercase tracking-wide text-muted">Missing: will be added</h3>}
          {res.to_add.map((r, i) => (
            <p key={i} className={row}><span className="min-w-0 truncate">{shortDate(r.date)} · {r.description}</span><span className={`num shrink-0 ${r.amount < 0 ? "text-good" : ""}`}>{r.amount < 0 ? "+" : ""}{sgd(Math.abs(r.amount))}</span></p>
          ))}

          {res.not_on_statement.length > 0 && <h3 className="pt-3 text-xs font-semibold uppercase tracking-wide text-muted">In Okanary but not on this statement (kept)</h3>}
          {res.not_on_statement.map((n) => (
            <p key={n.id} className={row}><span className="min-w-0 truncate">{prettyMerchant(n.merchant) || "Expense"}</span><span className="num shrink-0 text-muted">{sgd(n.amount_sgd_minor ?? 0)}</span></p>
          ))}

          {!res.applied && (res.to_add.length > 0 || res.matched.length > 0) && (
            <button disabled={busy} onClick={() => void go(true)} className="tap mt-4 w-full rounded-xl bg-accent font-semibold text-accent-fg disabled:opacity-40">Apply these changes</button>
          )}
          {res.applied && <p className="pt-3 text-sm font-medium text-good">Done: {res.applied.added} added, {res.applied.corrected} corrected, {res.applied.confirmed} confirmed.</p>}
        </section>
      )}
    </div>
  );
}
