import { useMemo, useState, type ReactNode } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { SUPPORTED_CURRENCIES, formatMoney, minorToDecimalString, sgtDate } from "@okanary/core";
import {
  RefreshLimitedError, api,
  type NetworthResponse, type NwAccountView, type NwChange, type NwHoldingView, type NwKind,
} from "../lib/api";
import { invalidateAll, useResource } from "../lib/data";
import { sgd, shortDate } from "../lib/format";
import {
  RANGES, groupByKind, parseMoneyInput, parseQuantity, pricesAsOfText, refreshLimitedText, signedSgd, todayText, toAreaData, updatedAgoText, KIND_LABEL, KIND_ORDER,
} from "../lib/networth";
import { MoneyTabs } from "../components/MoneyTabs";
import { Sheet } from "../components/Sheet";
import { useToast } from "../components/Toast";

const AXIS = { fontSize: 11, fill: "var(--muted)" } as const;
const tooltipStyle = { background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, fontSize: 12, color: "var(--fg)" } as const;
const axisDollars = (v: number) => (Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : String(Math.round(v)));
const field = "tap w-full rounded-xl border border-line bg-bg px-3";
const primaryBtn = "tap flex-1 rounded-full bg-sun font-extrabold text-sun-fg shadow-[0_3px_0_var(--sun-edge)] active:translate-y-[3px] active:shadow-none disabled:opacity-50";
const softBtn = "tap rounded-full border-2 border-dashed border-lilac bg-card px-4 text-[13px] font-extrabold text-accent active:bg-line/40";
const CURRENCIES = ["SGD", "USD", "IDR", "JPY", ...SUPPORTED_CURRENCIES.filter((c) => !["SGD", "USD", "IDR", "JPY"].includes(c))];

/** Chart series: asset classes stack upwards, liabilities sit alone below zero. Amber, never red, for what is owed. */
const SERIES = [
  { key: "cash", label: "Cash", color: "var(--essentials)", stack: "a" },
  { key: "stocks", label: "Stocks", color: "var(--lilac)", stack: "a" },
  { key: "crypto", label: "Crypto", color: "var(--peach)", stack: "a" },
  { key: "other", label: "Other", color: "var(--savings)", stack: "a" },
  { key: "liabilities", label: "Liabilities", color: "var(--lifestyle)", stack: "l" },
] as const;

const amberIfNegative = (n: number) => (n < 0 ? "text-lifestyle-ink" : "");
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Card({ title, right, children }: { title?: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-3 rounded-3xl bg-card p-4 shadow-sm">
      {(title || right) && (
        <div className="flex items-center justify-between gap-2 pb-2">
          <h2 className="text-sm font-semibold text-muted">{title}</h2>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

// ------------------------------------------------------------------ total + change

function ChangeCard({ title, c }: { title: string; c: NwChange | null }) {
  return (
    <div className="rounded-2xl bg-bg p-3">
      <p className="text-xs font-bold text-muted">{title}</p>
      {c ? (
        <>
          <p className={`num mt-1 text-lg ${amberIfNegative(c.change)}`}>{signedSgd(c.change)}</p>
          <p className="num mt-1 text-xs text-muted">You saved <span className="text-fg">{signedSgd(c.flows)}</span></p>
          <p className="num text-xs text-muted">Market <span className={c.market < 0 ? "text-lifestyle-ink" : "text-fg"}>{signedSgd(c.market)}</span></p>
          {c.partial && <p className="mt-1 text-[11px] text-muted">since {shortDate(c.from)}</p>}
        </>
      ) : (
        <p className="mt-1 text-xs text-muted">Shows once there is a snapshot to compare with.</p>
      )}
    </div>
  );
}

function TotalCard({ nw }: { nw: NetworthResponse }) {
  const [showDay, setShowDay] = useState(false);
  const day = nw.change.day;
  return (
    <section className="receipt relative mt-3 rounded-[22px] bg-card p-4 shadow-sm" aria-label="Net worth">
      <p className="text-[13px] font-bold text-muted">Net worth</p>
      <p className="big-num text-[40px] leading-[1.1]">{nw.latest ? sgd(nw.latest.net) : "…"}</p>
      {nw.latest && (
        <p className="num text-xs text-muted">{sgd(nw.latest.assets)} owned · {sgd(nw.latest.liabilities)} owed</p>
      )}
      {nw.live && <p className="mt-1 text-xs text-muted">Estimated from your latest balances and prices. The first daily snapshot is saved overnight.</p>}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <ChangeCard title="Past month" c={nw.change.month} />
        <ChangeCard title="This year" c={nw.change.ytd} />
      </div>
      {day && (
        <div className="mt-3 flex items-center gap-2">
          <button className="tap rounded-full border border-line px-3 text-xs font-bold text-muted active:bg-line/40" aria-expanded={showDay} onClick={() => setShowDay((v) => !v)}>Today</button>
          {showDay && <p className={`num text-xs ${amberIfNegative(day.change)}`}>{todayText(day)}</p>}
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ chart

function HistoryChart() {
  const [rangeId, setRangeId] = useState<(typeof RANGES)[number]["id"]>("1y");
  const days = RANGES.find((r) => r.id === rangeId)!.days;
  const history = useResource(`nwhistory:${days}`, () => api.networthHistory(days)).data;
  const data = useMemo(() => toAreaData(history ?? []), [history]);
  const hasLiab = data.some((d) => d.liabilities !== 0);
  return (
    <Card
      title="Over time"
      right={
        <div className="flex gap-1.5" role="tablist" aria-label="Range">
          {RANGES.map((r) => (
            <button key={r.id} role="tab" aria-selected={rangeId === r.id} onClick={() => setRangeId(r.id)} className={`tap rounded-full border px-3 text-xs font-bold ${rangeId === r.id ? "border-accent bg-accent text-accent-fg" : "border-line bg-bg"}`}>{r.label}</button>
          ))}
        </div>
      }
    >
      {data.length < 2 ? (
        <p className="py-6 text-center text-sm text-muted">{history ? "The chart fills in as daily snapshots build up." : "…"}</p>
      ) : (
        <>
          <div className="h-56" aria-label="Net worth by asset class">
            <ResponsiveContainer>
              <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--line)" vertical={false} />
                <XAxis dataKey="date" tick={AXIS} tickFormatter={shortDate} minTickGap={40} tickLine={false} axisLine={false} />
                <YAxis tick={AXIS} tickFormatter={axisDollars} tickLine={false} axisLine={false} width={40} />
                <Tooltip
                  contentStyle={tooltipStyle}
                  labelFormatter={(d: string) => shortDate(d)}
                  formatter={(v: number, name: string) => [sgd(Math.round(v * 100), false), SERIES.find((s) => s.key === name)?.label ?? name]}
                />
                {SERIES.filter((s) => s.key !== "liabilities" || hasLiab).map((s) => (
                  <Area key={s.key} type="monotone" dataKey={s.key} stackId={s.stack} stroke={s.color} fill={s.color} fillOpacity={0.75} strokeWidth={1.5} isAnimationActive={false} />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 pt-1 text-xs">
            {SERIES.filter((s) => s.key !== "liabilities" || hasLiab).map((s) => (
              <span key={s.key} className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: s.color }} />{s.label}</span>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ accounts, cards, holdings

function AccountsList({ accounts, onBalance, onEdit, onAdd }: { accounts: NwAccountView[]; onBalance: (a: NwAccountView) => void; onEdit: (a: NwAccountView) => void; onAdd: () => void }) {
  const groups = groupByKind(accounts);
  return (
    <Card title="Accounts" right={<button className={`${softBtn} !min-h-9 !px-3 text-xs`} onClick={onAdd}>Add</button>}>
      {groups.map((g) => (
        <div key={g.kind} className="pb-1">
          <p className="pt-2 text-[11px] font-extrabold uppercase tracking-wide text-muted">{g.label}</p>
          <div className="divide-y divide-line">
            {g.items.map((a) => (
              <div key={a.id} className="flex items-center gap-1">
                <button className="tap flex min-w-0 flex-1 items-center justify-between gap-2 py-2 text-left" onClick={() => onBalance(a)} aria-label={`Update balance for ${a.name}`}>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold">{a.name}</span>
                    <span className="block truncate text-xs text-muted">
                      {[a.institution, updatedAgoText(a.age_days)].filter(Boolean).join(" · ")}
                      {a.needs_update && <span className="ml-1.5 rounded-full border border-lifestyle bg-pill px-2 py-0.5 text-[11px] font-bold text-lifestyle-ink">update?</span>}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="num block text-sm">{a.value_sgd == null ? "not counted" : sgd(a.value_sgd)}</span>
                    {a.balance && a.balance.currency !== "SGD" && <span className="num block text-[11px] text-muted">{formatMoney(a.balance.amount_minor, a.balance.currency, { compact: true })}</span>}
                  </span>
                </button>
                <button className="tap px-2 text-xs font-bold text-accent" onClick={() => onEdit(a)} aria-label={`Edit ${a.name}`}>Edit</button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </Card>
  );
}

function CardLiabilities({ cards }: { cards: NetworthResponse["cards"] }) {
  const toast = useToast();
  if (cards.length === 0) return null;
  async function markPaid(accountId: string, statement: string) {
    try {
      await api.markStatementPaid(accountId, statement);
      invalidateAll();
      toast({
        msg: "Marked as paid", action: {
          label: "Undo", run: () => void api.unmarkStatementPaid(accountId, statement).then(() => invalidateAll()).catch((e) => toast({ msg: `Couldn't undo: ${errMsg(e)}` })),
        },
      });
    } catch (e) {
      toast({ msg: `Couldn't save: ${errMsg(e)}` });
    }
  }
  return (
    <Card title="Card balances">
      <div className="divide-y divide-line">
        {cards.map((c) => {
          const statement = c.last_statement ?? undefined;
          const canMark = !!statement && c.previous_bill > 0 && !c.previous_paid;
          return (
            <div key={c.account_id} className="flex items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{c.name}{c.estimate && <span className="ml-1.5 rounded-full bg-bg px-2 py-0.5 text-[11px] font-bold text-muted">estimate</span>}</p>
                {statement && <p className="text-xs text-muted">Statement {shortDate(statement)}</p>}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="num text-sm">{sgd(c.amount_sgd_minor)}</span>
                {canMark && <button className={`${softBtn} !min-h-9 !px-3 text-xs`} onClick={() => void markPaid(c.account_id, statement!)}>Mark statement paid</button>}
              </div>
            </div>
          );
        })}
      </div>
      <p className="pt-2 text-xs text-muted">Counted in your net worth from your card statement cycle.</p>
    </Card>
  );
}

function HoldingsList({ holdings, accounts, onEdit, onAdd }: { holdings: NwHoldingView[]; accounts: NwAccountView[]; onEdit: (h: NwHoldingView) => void; onAdd: () => void }) {
  const acctName = (id: string) => accounts.find((a) => a.id === id)?.name ?? "";
  return (
    <Card title="Holdings" right={<button className={`${softBtn} !min-h-9 !px-3 text-xs`} onClick={onAdd}>Add</button>}>
      {holdings.length === 0 && <p className="py-2 text-sm text-muted">Add US stocks, ETFs or crypto to see them priced in SGD.</p>}
      <div className="divide-y divide-line">
        {holdings.map((h) => (
          <button key={h.id} className="tap flex w-full items-start justify-between gap-3 py-2 text-left" onClick={() => onEdit(h)} aria-label={`Edit ${h.symbol}`}>
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold">{h.symbol}</span>
              <span className="num block text-xs text-muted">{h.quantity} × {h.price_minor != null && h.price_currency ? formatMoney(h.price_minor, h.price_currency) : "no price yet"}</span>
              <span className="block truncate text-[11px] text-muted">{acctName(h.account_id)}</span>
              {h.stale && <span className="mt-0.5 inline-block rounded-full bg-bg px-2 py-0.5 text-[11px] font-bold text-muted">stale{h.quote_date ? ` · quote from ${shortDate(h.quote_date)}` : ""}</span>}
            </span>
            <span className="shrink-0 text-right">
              <span className="num block text-sm">{h.value_sgd == null ? "–" : sgd(h.value_sgd)}</span>
              {h.gain_sgd != null && <span className={`num block text-xs ${h.gain_sgd < 0 ? "text-lifestyle-ink" : "text-good"}`}>gain {signedSgd(h.gain_sgd)}</span>}
              {h.day_move_sgd != null && <span className={`num block text-[11px] text-muted`}>today {signedSgd(h.day_move_sgd)}</span>}
            </span>
          </button>
        ))}
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ sheets

function Err({ msg }: { msg: string | null }) {
  return msg ? <p role="alert" className="px-1 text-xs font-semibold text-lifestyle-ink">{msg}</p> : null;
}

function AccountSheet({ account, onClose, onCreated }: { account: NwAccountView | null; onClose: () => void; onCreated: (a: { id: string; name: string; kind: NwKind; currency: string }) => void }) {
  const toast = useToast();
  const [name, setName] = useState(account?.name ?? "");
  const [kind, setKind] = useState<NwKind>(account?.kind ?? "cash");
  const [institution, setInstitution] = useState(account?.institution ?? "");
  const [currency, setCurrency] = useState(account?.currency ?? "SGD");
  const [include, setInclude] = useState(account ? !!account.include_in_networth : true);
  const [archived, setArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!name.trim()) return setError("Give the account a name.");
    setBusy(true);
    try {
      const input = { name: name.trim(), kind, institution: institution.trim() || null, currency, include_in_networth: include };
      if (account) {
        await api.patchNwAccount(account.id, { ...input, archived });
        invalidateAll();
        onClose();
      } else {
        const created = await api.createNwAccount(input);
        invalidateAll();
        onClose();
        onCreated({ id: created.id, name: created.name, kind: created.kind, currency: created.currency });
      }
    } catch (e) {
      setBusy(false);
      toast({ msg: `Couldn't save: ${errMsg(e)}` });
    }
  }

  return (
    <Sheet open onClose={onClose} title={account ? "Edit account" : "Add an account"}>
      <div className="space-y-2 px-4 pb-4 pt-2">
        <label className="block text-xs text-muted">Name
          <input className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. DBS Savings" />
        </label>
        <label className="block text-xs text-muted">Type
          <select className={field} value={kind} onChange={(e) => setKind(e.target.value as NwKind)}>
            {KIND_ORDER.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
        </label>
        <label className="block text-xs text-muted">Institution (optional)
          <input className={field} value={institution} onChange={(e) => setInstitution(e.target.value)} />
        </label>
        <label className="block text-xs text-muted">Currency
          <select className={field} value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="tap flex items-center gap-2 text-sm"><input type="checkbox" className="h-5 w-5" checked={include} onChange={(e) => setInclude(e.target.checked)} />Include in net worth</label>
        {account && (
          <label className="tap flex items-center gap-2 text-sm"><input type="checkbox" className="h-5 w-5" checked={archived} onChange={(e) => setArchived(e.target.checked)} />Archive (hide it and leave it out of net worth)</label>
        )}
        <Err msg={error} />
        <div className="flex gap-2 pt-1">
          <button disabled={busy} onClick={() => void save()} className={primaryBtn}>Save</button>
        </div>
      </div>
    </Sheet>
  );
}

interface BalanceTarget { id: string; name: string; kind: NwKind; currency: string; balance?: NwAccountView["balance"] }

function BalanceSheet({ account, onClose }: { account: BalanceTarget; onClose: () => void }) {
  const toast = useToast();
  const cur = account.balance?.currency ?? account.currency;
  const [amount, setAmount] = useState(account.balance ? minorToDecimalString(account.balance.amount_minor, cur) : "");
  const [asOf, setAsOf] = useState(sgtDate(new Date()));
  const [note, setNote] = useState("");
  const [flow, setFlow] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isLiab = account.kind === "liability";

  async function save() {
    const minor = parseMoneyInput(amount, cur);
    if (minor == null) return setError("Enter an amount like 1200 or 1200.50.");
    let flowMinor: number | null = null;
    if (account.kind === "manual_asset" && flow.trim() !== "") {
      flowMinor = parseMoneyInput(flow, cur, true);
      if (flowMinor == null) return setError("Enter the amount you added or withdrew, like 500 or -200.");
    }
    setBusy(true);
    try {
      await api.addNwBalance(account.id, { amount_minor: minor, currency: cur, as_of: asOf || undefined, note: note.trim() || null, flow_minor: flowMinor });
      invalidateAll();
      onClose();
    } catch (e) {
      setBusy(false);
      toast({ msg: `Couldn't save: ${errMsg(e)}` });
    }
  }

  async function removeLatest() {
    if (!account.balance || !window.confirm("Remove the latest balance entry for this account?")) return;
    try {
      await api.deleteNwBalance(account.balance.id);
      invalidateAll();
      onClose();
    } catch (e) {
      toast({ msg: `Couldn't remove: ${errMsg(e)}` });
    }
  }

  return (
    <Sheet open onClose={onClose} title={`${account.name}: ${isLiab ? "amount owed" : "balance"}`}>
      <div className="space-y-2 px-4 pb-4 pt-2">
        <label className="block text-xs text-muted">{isLiab ? "Amount owed" : "Balance"} ({cur})
          <input inputMode="decimal" className={field} value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
        </label>
        <label className="block text-xs text-muted">As of
          <input type="date" className={field} value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </label>
        {account.kind === "manual_asset" && (
          <label className="block text-xs text-muted">Of which you added or withdrew (optional, {cur})
            <input inputMode="decimal" className={field} value={flow} onChange={(e) => setFlow(e.target.value)} placeholder="e.g. 500, or -200 if you withdrew" />
            <span className="block pt-1">The rest counts as market growth.</span>
          </label>
        )}
        <input className={field} placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
        <Err msg={error} />
        <div className="flex gap-2 pt-1">
          {account.balance && <button onClick={() => void removeLatest()} className="tap rounded-full border-2 border-dashed border-line px-4 text-sm font-bold text-muted">Remove last</button>}
          <button disabled={busy} onClick={() => void save()} className={primaryBtn}>Save</button>
        </div>
      </div>
    </Sheet>
  );
}

function HoldingSheet({ holding, accounts, onClose }: { holding: NwHoldingView | null; accounts: NwAccountView[]; onClose: () => void }) {
  const toast = useToast();
  const choices = accounts.filter((a) => a.kind !== "liability");
  const [acct, setAcct] = useState(holding?.account_id ?? choices.find((a) => a.kind === "brokerage" || a.kind === "crypto")?.id ?? choices[0]?.id ?? "");
  const [type, setType] = useState<"us_equity" | "crypto">(holding?.asset_type ?? "us_equity");
  const [symbol, setSymbol] = useState(holding?.symbol ?? "");
  const [qty, setQty] = useState(holding?.quantity ?? "");
  const [cost, setCost] = useState(holding?.cost_basis_minor != null ? minorToDecimalString(holding.cost_basis_minor, holding.cost_currency ?? "SGD") : "");
  const [costCur, setCostCur] = useState(holding?.cost_currency ?? "SGD");
  const [acquired, setAcquired] = useState(holding?.acquired_at ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!acct) return setError("Add an account to hold this in first.");
    const sym = symbol.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9.\-_]{0,39}$/.test(sym)) return setError(type === "crypto" ? "Enter the CoinGecko id, like bitcoin." : "Enter a ticker, like VOO.");
    const quantity = parseQuantity(qty);
    if (quantity == null) return setError("Quantity should be a plain number above zero, like 0.05 or 12.5.");
    let costMinor: number | null = null;
    if (cost.trim() !== "") {
      costMinor = parseMoneyInput(cost, costCur);
      if (costMinor == null) return setError("Enter the cost basis like 1500 or 1500.50, or leave it empty.");
    }
    setBusy(true);
    try {
      const input = {
        account_id: acct, asset_type: type, symbol: sym, quantity,
        cost_basis_minor: costMinor, cost_currency: costMinor != null ? costCur : null, acquired_at: acquired || null,
      };
      if (holding) await api.patchNwHolding(holding.id, input);
      else await api.createNwHolding(input);
      invalidateAll();
      onClose();
    } catch (e) {
      setBusy(false);
      toast({ msg: `Couldn't save: ${errMsg(e)}` });
    }
  }

  async function del() {
    if (!holding || !window.confirm(`Remove ${holding.symbol} from your holdings?`)) return;
    try {
      await api.deleteNwHolding(holding.id);
      invalidateAll();
      onClose();
    } catch (e) {
      toast({ msg: `Couldn't remove: ${errMsg(e)}` });
    }
  }

  return (
    <Sheet open onClose={onClose} title={holding ? "Edit holding" : "Add a holding"}>
      <div className="space-y-2 px-4 pb-4 pt-2">
        {choices.length === 0 && <p className="text-sm text-muted">Add a brokerage or crypto account first, then come back to add holdings.</p>}
        <label className="block text-xs text-muted">Account
          <select className={field} value={acct} onChange={(e) => setAcct(e.target.value)}>
            {choices.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <div className="flex gap-2" role="tablist" aria-label="Asset type">
          {([["us_equity", "US stock / ETF"], ["crypto", "Crypto"]] as const).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={type === k} onClick={() => setType(k)} className={`tap flex-1 rounded-full border px-3 text-sm font-bold ${type === k ? "border-accent bg-accent text-accent-fg" : "border-line bg-bg"}`}>{label}</button>
          ))}
        </div>
        <label className="block text-xs text-muted">{type === "crypto" ? "Symbol" : "Ticker"}
          <input className={field} value={symbol} onChange={(e) => setSymbol(e.target.value)} autoCapitalize="none" autoCorrect="off" placeholder={type === "crypto" ? "bitcoin" : "VOO"} />
          {type === "crypto" && <span className="block pt-1">CoinGecko id, e.g. bitcoin</span>}
        </label>
        <label className="block text-xs text-muted">Quantity
          <input inputMode="decimal" className={field} value={qty} onChange={(e) => setQty(e.target.value)} placeholder={type === "crypto" ? "0.05" : "10"} />
        </label>
        <div className="flex gap-2">
          <label className="block flex-1 text-xs text-muted">Cost basis, total (optional)
            <input inputMode="decimal" className={field} value={cost} onChange={(e) => setCost(e.target.value)} />
          </label>
          <label className="block w-24 text-xs text-muted">Currency
            <select className={field} value={costCur} onChange={(e) => setCostCur(e.target.value)}>
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
        </div>
        <label className="block text-xs text-muted">Acquired (optional)
          <input type="date" className={field} value={acquired} onChange={(e) => setAcquired(e.target.value)} />
        </label>
        <Err msg={error} />
        <div className="flex gap-2 pt-1">
          {holding && <button onClick={() => void del()} className="tap rounded-full border-2 border-dashed border-line px-4 text-sm font-bold text-muted">Remove</button>}
          <button disabled={busy || choices.length === 0} onClick={() => void save()} className={primaryBtn}>Save</button>
        </div>
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ page

type SheetState =
  | { type: "account"; account: NwAccountView | null }
  | { type: "balance"; account: BalanceTarget }
  | { type: "holding"; holding: NwHoldingView | null }
  | null;

export function NetWorth() {
  const res = useResource("networth", api.networth);
  const toast = useToast();
  const [sheet, setSheet] = useState<SheetState>(null);
  const [refreshing, setRefreshing] = useState(false);
  const nw = res.data;
  const attribution = nw?.attribution ?? "Crypto prices by CoinGecko";

  async function refresh() {
    setRefreshing(true);
    try {
      const r = await api.refreshNetworth();
      invalidateAll();
      toast({ msg: r.failed.length > 0 ? "Updated. Some prices couldn't be fetched, so the last known ones are shown." : "Prices updated" });
    } catch (e) {
      toast({ msg: e instanceof RefreshLimitedError ? refreshLimitedText(e.retryAfterS) : `Couldn't refresh: ${errMsg(e)}` });
    } finally {
      setRefreshing(false);
    }
  }

  const close = () => setSheet(null);
  const asOf = pricesAsOfText(nw?.last_refresh_at);

  return (
    <div className="px-4 pb-6 pt-safe">
      <MoneyTabs />
      {res.error && !nw && <p className="py-6 text-center text-sm text-muted">Couldn't load net worth: {res.error}</p>}
      {nw && nw.accounts.length === 0 && (
        <Card>
          <h2 className="text-base font-extrabold">Your net worth, in one place</h2>
          <p className="pt-1 text-sm text-muted">Add your accounts (savings, brokerage, crypto, a robo-advisor) and Okanary shows what you own minus what you owe, and how much of the change came from your saving versus the market.</p>
          <button className={`${primaryBtn} mt-3 w-full`} onClick={() => setSheet({ type: "account", account: null })}>Add an account</button>
        </Card>
      )}
      {nw && nw.accounts.length > 0 && (
        <>
          <TotalCard nw={nw} />
          <HistoryChart />
          <AccountsList
            accounts={nw.accounts}
            onBalance={(a) => setSheet({ type: "balance", account: { id: a.id, name: a.name, kind: a.kind, currency: a.currency, balance: a.balance } })}
            onEdit={(a) => setSheet({ type: "account", account: a })}
            onAdd={() => setSheet({ type: "account", account: null })}
          />
          <CardLiabilities cards={nw.cards} />
          <HoldingsList holdings={nw.holdings} accounts={nw.accounts} onEdit={(h) => setSheet({ type: "holding", holding: h })} onAdd={() => setSheet({ type: "holding", holding: null })} />
          <div className="mt-3 flex items-center justify-between gap-3 px-1">
            <p className="num text-xs text-muted">{asOf ?? "Prices not refreshed yet"}</p>
            <button className={softBtn} disabled={refreshing} onClick={() => void refresh()}>{refreshing ? "Refreshing…" : "Refresh now"}</button>
          </div>
        </>
      )}
      <p className="pt-4 text-center text-xs text-muted">
        <a href="https://www.coingecko.com" target="_blank" rel="noopener noreferrer" className="underline">{attribution}</a>
      </p>

      {sheet?.type === "account" && (
        <AccountSheet
          account={sheet.account}
          onClose={close}
          onCreated={(a) => setSheet({ type: "balance", account: a })}
        />
      )}
      {sheet?.type === "balance" && <BalanceSheet account={sheet.account} onClose={close} />}
      {sheet?.type === "holding" && <HoldingSheet holding={sheet.holding} accounts={nw?.accounts ?? []} onClose={close} />}
    </div>
  );
}
