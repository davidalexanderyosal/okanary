import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { convertMinor, currencySymbol, formatMoney, minorToDecimalString, sgtDate } from "@okanary/core";
import { api, type WantItem, type WantMatch, type WantSkipOffer } from "../lib/api";
import { invalidateAll, useResource } from "../lib/data";
import { dayLabel, prettyMerchant, sgd } from "../lib/format";
import { keypadMinor } from "../lib/keypad";
import { WANT_TABS, WAIT_CHOICES, countdownText, decidedLine, defaultWaitForPrice, notBoughtText, parsePrefill, parseWantTab, skipOfferText, waitChipLabel, type WantTab } from "../lib/wants";
import { Sheet } from "../components/Sheet";
import { useToast } from "../components/Toast";

const CURRENCIES = ["SGD", "IDR", "JPY", "USD", "MYR", "EUR", "GBP", "THB", "AUD", "KRW"];
const chip = (on: boolean) => `tap shrink-0 rounded-full border px-3.5 text-sm font-medium ${on ? "border-accent bg-accent text-accent-fg" : "border-line bg-bg"}`;
const btnPrimary = "tap flex-1 rounded-full bg-sun font-extrabold text-sun-fg shadow-[0_3px_0_var(--sun-edge)] active:translate-y-[3px] active:shadow-none disabled:opacity-40";
const btnSoft = "tap flex-1 rounded-full border border-line bg-bg font-bold";
const field = "tap w-full rounded-xl border border-line bg-bg px-3";

type Dialog =
  | { kind: "early"; want: WantItem }
  | { kind: "offer"; want: WantItem; offer: WantSkipOffer }
  | { kind: "match"; want: WantItem; matches: WantMatch[] };

const host = (url: string) => { try { return new URL(url).host.replace(/^www\./, ""); } catch { return url; } };
const safeHref = (url: string) => (/^https?:\/\//i.test(url) ? url : `https://${url}`);

/** Quick add: name, price (S$ or another currency), wait chips (3 / 7 / 30 / custom; the default follows the price). */
function AddWant({ prefill }: { prefill: ReturnType<typeof parsePrefill> }) {
  const toast = useToast();
  const setup = useResource("setup", api.setup).data;
  const threshold = setup?.wants.long_wait_threshold_minor;
  const [name, setName] = useState(prefill?.name ?? "");
  const [currency, setCurrency] = useState(prefill?.currency ?? "SGD");
  const [price, setPrice] = useState(prefill?.priceMinor ? minorToDecimalString(prefill.priceMinor, prefill.currency ?? "SGD") : "");
  const [manualSgd, setManualSgd] = useState("");
  const [wait, setWait] = useState<number | "custom" | null>(null); // null = follow the default
  const [custom, setCustom] = useState("14");
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);

  const rate = useResource(`fx:${currency}`, () => (currency !== "SGD" ? api.fx(currency).catch(() => null) : Promise.resolve(null))).data ?? null;
  const minor = keypadMinor(price, currency);
  const sgdMinor = currency === "SGD" ? minor : manualSgd.trim() ? keypadMinor(manualSgd, "SGD") : rate && minor > 0 ? convertMinor(minor, currency, "SGD", rate.rate) : null;
  const dflt = defaultWaitForPrice(sgdMinor, threshold);
  const customDays = Math.min(365, Math.max(0, Math.floor(Number(custom) || 0)));
  const effective = wait === "custom" ? customDays : wait ?? dflt;
  const needsSgd = currency !== "SGD" && minor > 0 && !rate && !manualSgd.trim();

  async function add() {
    if (!name.trim() || minor <= 0 || busy) return;
    setBusy(true);
    try {
      await api.createWant({
        name: name.trim(), price_minor: minor, currency, wait_days: effective,
        ...(currency !== "SGD" && manualSgd.trim() ? { price_sgd_minor: keypadMinor(manualSgd, "SGD") } : {}),
        url: url.trim() || null, note: note.trim() || null,
      });
      invalidateAll();
      setName(""); setPrice(""); setManualSgd(""); setWait(null); setUrl(""); setNote(""); setMore(false);
      toast({ msg: effective === 0 ? "Added. It's ready to decide." : `Added. Decide in ${effective} ${effective === 1 ? "day" : "days"}.` });
    } catch (e) {
      toast({ msg: `Couldn't add: ${e instanceof Error ? e.message : e}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-3xl bg-card p-4 shadow-sm" aria-label="Add a want">
      <h2 className="pb-2 text-sm font-extrabold text-accent">Something you want?</h2>
      <input className={field} placeholder="What is it?" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} aria-label="Name" />
      <div className="mt-2 flex gap-2">
        <select className="tap w-24 rounded-xl border border-line bg-bg px-2" value={currency} onChange={(e) => { setCurrency(e.target.value); setPrice(""); setManualSgd(""); }} aria-label="Currency">
          {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <input className={`${field} num`} inputMode="decimal" placeholder={`Price (${currencySymbol(currency).trim()})`} value={price} onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ""))} aria-label="Price" />
      </div>
      {currency !== "SGD" && minor > 0 && (
        <p className="num mt-1 text-xs text-muted">{rate ? `≈ ${sgd(sgdMinor ?? 0)} at ${rate.rate}` : "Rate unavailable: enter the SGD amount"}</p>
      )}
      {(needsSgd || (currency !== "SGD" && manualSgd.trim() !== "")) && (
        <input className={`${field} num mt-2`} inputMode="decimal" placeholder="Amount in SGD" value={manualSgd} onChange={(e) => setManualSgd(e.target.value.replace(/[^\d.]/g, ""))} aria-label="Amount in SGD" />
      )}

      <p className="pb-1.5 pt-3 text-xs font-bold text-muted">Wait before deciding</p>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Wait">
        {WAIT_CHOICES.map((d) => <button key={d} type="button" className={chip(wait === "custom" ? false : effective === d)} aria-pressed={wait !== "custom" && effective === d} onClick={() => setWait(d)}>{waitChipLabel(d)}</button>)}
        <button type="button" className={chip(wait === "custom")} aria-pressed={wait === "custom"} onClick={() => setWait("custom")}>Custom</button>
        {wait === "custom" && (
          <label className="flex items-center gap-1.5 text-sm"><input className="tap num w-16 rounded-xl border border-line bg-bg px-2 text-center" inputMode="numeric" value={custom} onChange={(e) => setCustom(e.target.value.replace(/\D/g, "").slice(0, 3))} aria-label="Custom wait in days" /> days</label>
        )}
      </div>
      {wait === null && <p className="pt-1 text-[11px] text-muted">{dflt === 30 ? "30 days for bigger buys." : "7 days is the usual."}</p>}

      {more && (
        <div className="mt-3 space-y-2">
          <input className={field} placeholder="Link (optional)" value={url} maxLength={500} onChange={(e) => setUrl(e.target.value)} aria-label="Link" />
          <input className={field} placeholder="Note (optional)" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
        </div>
      )}
      <div className="mt-3 flex items-center gap-2">
        <button type="button" className="tap shrink-0 px-1 text-sm font-medium text-accent" onClick={() => setMore((m) => !m)}>{more ? "Fewer" : "Link / note"}</button>
        <button className={btnPrimary} disabled={busy || !name.trim() || minor <= 0 || needsSgd} onClick={() => void add()}>Add to want list</button>
      </div>
    </section>
  );
}

export function Wants() {
  const [params, setParams] = useSearchParams();
  const tab = parseWantTab(params.get("tab"));
  // Quick add / Home hand-off: /wants?add=1&price=..&cur=..&name=.. fills the form once, then only the tab stays in the URL.
  const [prefill, setPrefill] = useState<ReturnType<typeof parsePrefill>>(null);
  const [formKey, setFormKey] = useState(0);
  const toast = useToast();
  const data = useResource("wants", api.wants);
  const d = data.data;
  const [dlg, setDlg] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState(false);
  const today = sgtDate(new Date());

  useEffect(() => {
    const p = parsePrefill(params);
    if (!p) return;
    setPrefill(p);
    setFormKey((k) => k + 1);
    setParams(params.get("tab") ? { tab: params.get("tab")! } : {}, { replace: true });
  }, [params, setParams]);

  const setTab = (t: WantTab) => setParams(t === "waiting" ? {} : { tab: t }, { replace: true });
  const stat = notBoughtText(d?.stats);

  async function buy(w: WantItem, confirmEarly = false) {
    setBusy(true);
    try {
      const r = await api.buyWant(w.id, confirmEarly);
      invalidateAll();
      if (r.matches.length > 0) setDlg({ kind: "match", want: r.want, matches: r.matches });
      else { setDlg(null); toast({ msg: "Recorded. Enjoy it!" }); }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("confirm_early")) setDlg({ kind: "early", want: w });
      else if (msg.startsWith("409")) { setDlg(null); invalidateAll(); toast({ msg: "That one was already decided." }); }
      else toast({ msg: `Couldn't save: ${msg}` });
    } finally {
      setBusy(false);
    }
  }

  async function skip(w: WantItem) {
    setBusy(true);
    try {
      const r = await api.skipWant(w.id);
      invalidateAll();
      if (r.offer) setDlg({ kind: "offer", want: r.want, offer: r.offer });
      else toast({ msg: `Skipped. ${sgd(r.want.price_sgd_minor)} stays with you.` });
    } catch (e) {
      toast({ msg: `Couldn't save: ${e instanceof Error ? e.message : e}` });
    } finally {
      setBusy(false);
    }
  }

  async function pledge(want: WantItem, offer: WantSkipOffer) {
    setBusy(true);
    try {
      await api.pledgeWant(want.id, offer.goal_id);
      invalidateAll();
      setDlg(null);
      toast({ msg: `Added to ${offer.emoji ? `${offer.emoji} ` : ""}${offer.name} as a pledge.` });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setDlg(null);
      toast({ msg: msg.startsWith("409") ? "That one is already added to a goal." : `Couldn't save: ${msg}` });
    } finally {
      setBusy(false);
    }
  }

  async function link(want: WantItem, txn: WantMatch) {
    setBusy(true);
    try {
      await api.linkWant(want.id, txn.id);
      invalidateAll();
      setDlg(null);
      toast({ msg: "Linked to the transaction." });
    } catch (e) {
      toast({ msg: `Couldn't link: ${e instanceof Error ? e.message : e}` });
    } finally {
      setBusy(false);
    }
  }

  async function findMatches(w: WantItem) {
    try {
      const r = await api.wantMatches(w.id);
      if (r.matches.length === 0) toast({ msg: "No matching transaction yet." });
      else setDlg({ kind: "match", want: w, matches: r.matches });
    } catch (e) {
      toast({ msg: `Couldn't look: ${e instanceof Error ? e.message : e}` });
    }
  }

  async function remove(w: WantItem) {
    try {
      await api.deleteWant(w.id);
      invalidateAll();
      toast({ msg: "Removed." });
    } catch (e) {
      toast({ msg: `Couldn't remove: ${e instanceof Error ? e.message : e}` });
    }
  }

  const items = d ? (tab === "waiting" ? d.waiting : tab === "ready" ? d.ready : d.decided) : [];
  const counts: Record<WantTab, number> = { waiting: d?.waiting.length ?? 0, ready: d?.ready.length ?? 0, decided: d?.decided.length ?? 0 };
  const price = (w: WantItem) => (w.currency === "SGD" ? sgd(w.price_minor) : `${formatMoney(w.price_minor, w.currency, { compact: true })} · ${sgd(w.price_sgd_minor)}`);

  return (
    <div className="px-4 pb-8 pt-safe">
      <Link to="/" className="tap inline-flex items-center pt-3 text-sm text-accent">‹ Home</Link>
      <h1 className="text-2xl font-bold">Want list</h1>
      <p className="pb-3 text-sm text-muted">Give it a little time. Buy it, or let it go; both are fine.</p>
      {stat && <p className="num mb-3 rounded-full border-[1.5px] border-mint-line bg-mint-bg px-3 py-2 text-[13px] font-bold">{stat}</p>}

      <AddWant key={formKey} prefill={prefill} />

      <div className="mt-4 flex gap-2" role="tablist" aria-label="Want list">
        {WANT_TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`tap rounded-full border px-4 text-sm ${tab === k ? "border-accent bg-accent text-accent-fg" : "border-line bg-card"}`}>
            {label}{counts[k] > 0 ? ` · ${counts[k]}` : ""}
          </button>
        ))}
      </div>

      <div className="mt-3 space-y-2">
        {d && items.length === 0 && (
          <p className="py-8 text-center text-sm text-muted">
            {tab === "waiting" ? "Nothing waiting. Add something above when you feel the pull." : tab === "ready" ? "Nothing ready to decide yet." : "Nothing decided yet."}
          </p>
        )}
        {data.error && !d && <p className="py-6 text-center text-sm text-muted">Couldn't load: {data.error}</p>}
        {items.map((w) => (
          <article key={w.id} className="rounded-3xl bg-card p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="break-words font-semibold">{w.name}</p>
                <p className="num text-sm text-muted">{price(w)}</p>
              </div>
              {w.status === "waiting" || w.status === "ready" ? (
                <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-extrabold ${w.left.due ? "border-mint-line bg-mint-bg" : "border-line bg-pill text-muted"}`}>{countdownText(w.left)}</span>
              ) : null}
            </div>
            {(w.url || w.note) && (
              <p className="mt-1 break-words text-xs text-muted">
                {w.url && <a href={safeHref(w.url)} target="_blank" rel="noreferrer noopener" className="text-accent underline">{host(w.url)}</a>}
                {w.url && w.note ? " · " : ""}{w.note}
              </p>
            )}
            {(w.status === "waiting" || w.status === "ready") ? (
              <div className="mt-3 flex items-center gap-2">
                <button className={btnPrimary} disabled={busy} onClick={() => void (w.status === "waiting" && !w.left.due ? setDlg({ kind: "early", want: w }) : buy(w))}>Buy</button>
                <button className={btnSoft} disabled={busy} onClick={() => void skip(w)}>Skip</button>
                <button className="tap shrink-0 px-2 text-xs text-muted underline" aria-label={`Remove ${w.name}`} onClick={() => void remove(w)}>Remove</button>
              </div>
            ) : (
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <p className="text-xs text-muted">
                  {decidedLine(w, sgtDate)}{w.status === "bought" && w.transaction_id ? " · linked" : ""}
                  {w.decided_at && <span className="sr-only"> ({dayLabel(w.decided_at, today)})</span>}
                </p>
                {w.status === "bought" && !w.transaction_id && <button className="tap shrink-0 px-1 text-xs font-bold text-accent" onClick={() => void findMatches(w)}>Link purchase</button>}
              </div>
            )}
          </article>
        ))}
      </div>

      <Sheet open={dlg?.kind === "early"} onClose={() => setDlg(null)} title="Bought before the wait ended?">
        {dlg?.kind === "early" && (
          <div className="space-y-3 px-5 pb-4 pt-2">
            <p className="text-sm text-muted">It's fine either way. Okanary just notes that {dlg.want.name} was bought early.</p>
            <div className="flex gap-2">
              <button className={btnPrimary} disabled={busy} onClick={() => void buy(dlg.want, true)}>Yes, I bought it</button>
              <button className={btnSoft} onClick={() => setDlg(null)}>Not yet</button>
            </div>
          </div>
        )}
      </Sheet>

      <Sheet open={dlg?.kind === "offer"} onClose={() => setDlg(null)} title="Skipped. Nice one.">
        {dlg?.kind === "offer" && (
          <div className="space-y-3 px-5 pb-4 pt-2">
            <p className="text-base font-bold">{skipOfferText(dlg.offer)}</p>
            <p className="text-sm text-muted">It's a pledge: you move the money yourself, then mark it done on the goal.</p>
            <div className="flex gap-2">
              <button className={btnPrimary} disabled={busy} onClick={() => void pledge(dlg.want, dlg.offer)}>Add it</button>
              <button className={btnSoft} onClick={() => setDlg(null)}>No thanks</button>
            </div>
          </div>
        )}
      </Sheet>

      <Sheet open={dlg?.kind === "match"} onClose={() => setDlg(null)} title="Is this the purchase?">
        {dlg?.kind === "match" && (
          <div className="space-y-2 px-5 pb-4 pt-2">
            <p className="text-sm text-muted">Recorded. These transactions look like {dlg.want.name}; link one if it's right.</p>
            {dlg.matches.map((t) => (
              <div key={t.id} className="flex items-center justify-between gap-2 rounded-2xl bg-bg px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{t.merchant ? prettyMerchant(t.merchant) : "Transaction"}</p>
                  <p className="num text-xs text-muted">{dayLabel(t.occurred_at, today)} · {sgd(t.amount_sgd_minor)}</p>
                </div>
                <button className="tap shrink-0 rounded-full bg-accent px-4 text-sm font-bold text-accent-fg disabled:opacity-50" disabled={busy} onClick={() => void link(dlg.want, t)}>Link</button>
              </div>
            ))}
            <button className={`${btnSoft} w-full`} onClick={() => setDlg(null)}>Not now</button>
          </div>
        )}
      </Sheet>
    </div>
  );
}
