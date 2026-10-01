import { useState } from "react";
import { Link } from "react-router-dom";
import type { Account } from "@okanary/core";
import { api, type Trip } from "../lib/api";
import { invalidateAll, useResource } from "../lib/data";
import { useRefData } from "../lib/refdata";
import { useToast } from "../components/Toast";

const field = "tap w-full rounded-xl border border-line bg-bg px-3";

function AccountForm({ initial, onDone }: { initial?: Account; onDone: () => void }) {
  const toast = useToast();
  const [v, setV] = useState({
    name: initial?.name ?? "", kind: initial?.kind ?? "credit", bank: initial?.bank ?? "", last4: initial?.last4 ?? "",
    wallet_card_name: initial?.wallet_card_name ?? "", statement_day: initial?.statement_day?.toString() ?? "", due_day: initial?.due_day?.toString() ?? "",
  });
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });
  async function save() {
    const body = {
      name: v.name.trim(), kind: v.kind as Account["kind"], bank: v.bank.trim() || null, last4: v.last4.trim() || null,
      wallet_card_name: v.wallet_card_name.trim() || null,
      statement_day: v.statement_day ? Number(v.statement_day) : null, due_day: v.due_day ? Number(v.due_day) : null,
    };
    try {
      if (initial) await api.patchAccount(initial.id, body); else await api.createAccount(body);
      invalidateAll();
      onDone();
    } catch (e) {
      toast({ msg: `Couldn't save: ${e instanceof Error ? e.message : e}` });
    }
  }
  return (
    <div className="space-y-2 rounded-2xl bg-bg p-3">
      <input className={field} placeholder="Name (e.g. DBS Altitude)" value={v.name} onChange={set("name")} />
      <select className={field} value={v.kind} onChange={set("kind")} aria-label="Kind">
        <option value="credit">Credit card</option><option value="debit">Debit</option><option value="cash">Cash</option><option value="ewallet">E-wallet</option>
      </select>
      <div className="flex gap-2">
        <input className={field} placeholder="Bank" value={v.bank} onChange={set("bank")} />
        <input className={`${field} w-28`} placeholder="Last 4" inputMode="numeric" maxLength={4} value={v.last4} onChange={set("last4")} />
      </div>
      <input className={field} placeholder="Apple Wallet card name (for auto-capture later)" value={v.wallet_card_name} onChange={set("wallet_card_name")} />
      <div className="flex gap-2">
        <input className={field} placeholder="Statement day" inputMode="numeric" value={v.statement_day} onChange={set("statement_day")} />
        <input className={field} placeholder="Due day" inputMode="numeric" value={v.due_day} onChange={set("due_day")} />
      </div>
      <div className="flex gap-2">
        <button className="tap rounded-xl border border-line px-4" onClick={onDone}>Cancel</button>
        <button className="tap flex-1 rounded-xl bg-accent font-semibold text-accent-fg disabled:opacity-40" disabled={!v.name.trim()} onClick={() => void save()}>Save</button>
      </div>
    </div>
  );
}

function TripForm({ initial, onDone }: { initial?: Trip; onDone: () => void }) {
  const toast = useToast();
  const [v, setV] = useState({ name: initial?.name ?? "", start: initial?.start_date ?? "", end: initial?.end_date ?? "", currency: initial?.currency ?? "" });
  async function save() {
    const body = { name: v.name.trim(), start_date: v.start || null, end_date: v.end || null, currency: v.currency || null };
    try {
      if (initial) await api.patchTrip(initial.id, body); else await api.createTrip(body);
      invalidateAll();
      onDone();
    } catch (e) { toast({ msg: `Couldn't save: ${e instanceof Error ? e.message : e}` }); }
  }
  return (
    <div className="space-y-2 rounded-2xl bg-bg p-3">
      <input className={field} placeholder="Trip name (e.g. Tokyo Dec 2026)" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
      <div className="flex gap-2">
        <input type="date" className={field} value={v.start} onChange={(e) => setV({ ...v, start: e.target.value })} aria-label="Start date" />
        <input type="date" className={field} value={v.end} onChange={(e) => setV({ ...v, end: e.target.value })} aria-label="End date" />
      </div>
      <select className={field} value={v.currency} onChange={(e) => setV({ ...v, currency: e.target.value })} aria-label="Trip currency">
        <option value="">Currency: none</option>
        {["IDR", "JPY", "USD", "MYR", "EUR", "GBP", "THB", "AUD", "KRW"].map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      <div className="flex gap-2">
        <button className="tap rounded-xl border border-line px-4" onClick={onDone}>Cancel</button>
        <button className="tap flex-1 rounded-xl bg-accent font-semibold text-accent-fg disabled:opacity-40" disabled={!v.name.trim()} onClick={() => void save()}>Save</button>
      </div>
    </div>
  );
}

export function Settings() {
  const ref = useRefData();
  const rules = useResource("rules", api.rules);
  const toast = useToast();
  const trips = useResource("trips", api.trips);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [editingTrip, setEditingTrip] = useState<string | "new" | null>(null);
  const [newCat, setNewCat] = useState<{ group: string; name: string }>({ group: "lifestyle", name: "" });

  return (
    <div className="px-4 pb-8 pt-safe">
      <h1 className="pb-2 pt-4 text-2xl font-bold">Settings</h1>

      <section className="rounded-3xl bg-card p-4 shadow-sm">
        <div className="flex items-center justify-between pb-2"><h2 className="text-sm font-semibold text-muted">Accounts &amp; cards</h2>
          <button className="tap text-sm font-medium text-accent" onClick={() => setEditing("new")}>+ Add</button></div>
        {ref.accounts.length === 0 && editing !== "new" && <p className="pb-2 text-sm text-muted">No accounts yet. Add your DBS and Citi cards.</p>}
        {editing === "new" && <AccountForm onDone={() => setEditing(null)} />}
        {ref.accounts.map((a) => editing === a.id ? (
          <AccountForm key={a.id} initial={a} onDone={() => setEditing(null)} />
        ) : (
          <div key={a.id} className="flex items-center justify-between">
            <button className="tap flex-1 text-left" onClick={() => setEditing(a.id)}>
              <span className="block font-medium">{a.name}</span>
              <span className="block text-xs text-muted">{a.kind}{a.last4 ? ` ····${a.last4}` : ""}{a.statement_day ? ` · statement day ${a.statement_day}` : ""}</span>
            </button>
            <button className="tap text-sm text-danger" onClick={() => void api.patchAccount(a.id, { archived: 1 } as Partial<Account>).then(invalidateAll)}>Archive</button>
          </div>
        ))}
      </section>

      <section className="mt-4 rounded-3xl bg-card p-4 shadow-sm">
        <h2 className="pb-2 text-sm font-semibold text-muted">Categories</h2>
        {ref.groups.map((g) => (
          <div key={g.id} className="pb-2">
            <p className="pt-1 text-sm font-semibold">{g.name} {!g.counts_as_spend && <span className="text-xs font-normal text-muted">(not counted as spend)</span>}</p>
            <div className="flex flex-wrap gap-2 pt-1">
              {ref.categories.filter((c) => c.group_id === g.id && !c.archived).map((c) => (
                <button key={c.id} className="tap rounded-full border border-line bg-bg px-3 text-sm" title="Tap to archive"
                  onClick={() => window.confirm(`Archive “${c.name}”? Existing transactions keep it.`) && void api.patchCategory(c.id, { archived: 1 }).then(invalidateAll)}>{c.name}</button>
              ))}
            </div>
          </div>
        ))}
        <div className="mt-2 flex gap-2">
          <select className={`${field} w-36`} value={newCat.group} onChange={(e) => setNewCat({ ...newCat, group: e.target.value })} aria-label="Group">
            {ref.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
          <input className={field} placeholder="New category" value={newCat.name} onChange={(e) => setNewCat({ ...newCat, name: e.target.value })} />
          <button className="tap rounded-xl bg-accent px-4 font-semibold text-accent-fg disabled:opacity-40" disabled={!newCat.name.trim()}
            onClick={() => void api.createCategory({ group_id: newCat.group, name: newCat.name.trim() }).then(() => { invalidateAll(); setNewCat({ ...newCat, name: "" }); }).catch((e) => toast({ msg: String(e) }))}>Add</button>
        </div>
      </section>

      <section className="mt-4 rounded-3xl bg-card p-4 shadow-sm">
        <div className="flex items-center justify-between pb-2"><h2 className="text-sm font-semibold text-muted">Trips</h2>
          <button className="tap text-sm font-medium text-accent" onClick={() => setEditingTrip("new")}>+ Add</button></div>
        {(trips.data ?? []).length === 0 && editingTrip !== "new" && <p className="pb-1 text-sm text-muted">Trips tag purchases by date and suggest the trip's currency in Quick add.</p>}
        {editingTrip === "new" && <TripForm onDone={() => setEditingTrip(null)} />}
        {(trips.data ?? []).map((t) => editingTrip === t.id ? (
          <TripForm key={t.id} initial={t} onDone={() => setEditingTrip(null)} />
        ) : (
          <div key={t.id} className="flex items-center justify-between">
            <button className="tap flex-1 text-left" onClick={() => setEditingTrip(t.id)}>
              <span className="block font-medium">{t.name}</span>
              <span className="block text-xs text-muted">{t.start_date ?? "?"} → {t.end_date ?? "?"}{t.currency ? ` · ${t.currency}` : ""}</span>
            </button>
            <button className="tap text-sm text-danger" onClick={() => window.confirm(`Delete “${t.name}”? Its transactions stay, untagged.`) && void api.deleteTrip(t.id).then(invalidateAll)}>Delete</button>
          </div>
        ))}
      </section>

      <section className="mt-4 rounded-3xl bg-card p-4 shadow-sm">
        <h2 className="pb-2 text-sm font-semibold text-muted">Merchant rules</h2>
        {(rules.data ?? []).length === 0 && <p className="text-sm text-muted">No rules yet. Change a category and tap “Always” to teach Okanary.</p>}
        {(rules.data ?? []).map((r) => (
          <div key={r.id} className="flex items-center justify-between py-1 text-sm">
            <span className="min-w-0"><span className="font-mono text-xs">{r.pattern}</span> <span className="text-muted">({r.match_type})</span> → <b>{r.set_excluded ? "excluded" : r.category_name}</b><span className="text-xs text-muted"> · {r.hits} hits</span></span>
            <button className="tap text-danger" aria-label="Delete rule" onClick={() => void api.deleteRule(r.id).then(invalidateAll)}>✕</button>
          </div>
        ))}
      </section>

      <Link to="/setup" className="tap mt-4 flex items-center justify-between rounded-3xl bg-card p-4 font-medium shadow-sm"><span>Auto-capture &amp; notifications</span><span className="text-muted">›</span></Link>

      <section className="mt-4 rounded-3xl bg-card p-4 text-sm text-muted shadow-sm">
        <h2 className="pb-1 font-semibold">Install on iPhone</h2>
        <p>Safari → Share → <b>Add to Home Screen</b>. Open Okanary from the Home Screen icon (needed for notifications later).</p>
      </section>
    </div>
  );
}
