import { useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { SUPPORTED_CURRENCIES, minorToDecimalString, sgtDate, type Cycle } from "@okanary/core";
import { api, type SubscriptionItem } from "../lib/api";
import { invalidateAll, useResource } from "../lib/data";
import { sgd } from "../lib/format";
import { useRefData } from "../lib/refdata";
import {
  CYCLE_LABEL, buildPayload, defaultNextRenewal, displayName, flagLines, groupSubscriptions, itemPriceText, candidateText, monthlyHint, nextLine, rollForwardRenewal,
  sgdHint, sourceLabel, stillUsingList, type FlagKind, type SubForm,
} from "../lib/subscriptions";
import { Sheet } from "../components/Sheet";
import { useToast } from "../components/Toast";

const field = "tap w-full rounded-xl border border-line bg-bg px-3";
const primaryBtn = "tap flex-1 rounded-full bg-sun font-extrabold text-sun-fg shadow-[0_3px_0_var(--sun-edge)] active:translate-y-[3px] active:shadow-none disabled:opacity-50";
const softBtn = "tap rounded-full border-2 border-dashed border-lilac bg-card px-4 text-[13px] font-extrabold text-accent active:bg-line/40 disabled:opacity-50";
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const CYCLE_LIST: Cycle[] = ["weekly", "monthly", "quarterly", "yearly"];

/** Subscriptions hub (v2 S): everything that bills on a schedule, however it got here. Okanary never cancels anything itself. */
export function Subscriptions() {
  const [params] = useSearchParams();
  const check = params.get("check") === "1";
  const data = useResource("subscriptions", api.subscriptions);
  const ref = useRefData();
  const toast = useToast();
  const d = data.data;
  const [sheet, setSheet] = useState<{ item: SubscriptionItem | null } | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  const today = sgtDate(new Date());

  /** Runs an API call, refreshes the page data and toasts; failures read plainly. */
  async function run(fn: () => Promise<unknown>, msg?: string) {
    try {
      await fn();
      invalidateAll();
      if (msg) toast({ msg });
      return true;
    } catch (e) {
      toast({ msg: `Couldn't do that: ${errMsg(e)}` });
      return false;
    }
  }

  /** Records the intent to cancel, then opens the service's own page when we know it (Okanary cannot cancel for anyone). */
  async function wantCancel(s: SubscriptionItem) {
    try {
      const r = await api.cancelIntentSubscription(s.id);
      invalidateAll();
      const url = r.cancel_url;
      if (url) {
        const w = window.open(url, "_blank");
        if (w) w.opener = null;
        toast({ msg: "Okanary can't cancel for you — this opens the service's page", action: w ? undefined : { label: "Open page", run: () => { window.open(url, "_blank"); } } });
      } else {
        toast({ msg: "Noted. Okanary can't cancel for you — cancel it with the service itself." });
      }
    } catch (e) {
      toast({ msg: `Couldn't do that: ${errMsg(e)}` });
    }
  }

  const act = {
    confirm: (s: SubscriptionItem) => run(() => api.confirmSubscription(s.id), "Added to your subscriptions"),
    notOne: (s: SubscriptionItem) => run(() => api.dismissSubscription(s.id), "Okay, won't suggest it again"),
    accept: (s: SubscriptionItem) => run(() => api.acceptSubscriptionPrice(s.id), "New price saved"),
    review: async (s: SubscriptionItem) => { if (await run(() => api.reviewSubscriptionPrice(s.id))) setSheet({ item: s }); },
    cancelled: (s: SubscriptionItem) => run(() => api.markSubscriptionCancelled(s.id), "Marked as cancelled"),
    reactivate: (s: SubscriptionItem) => run(() => api.patchSubscription(s.id, { status: "active" }), "Back in your list"),
    /** Keep; for a missing charge also move the expected date to the next one so the quiet flag clears. */
    keep: (s: SubscriptionItem) => run(async () => {
      await api.keepSubscription(s.id);
      if (s.flags.missing && s.next_renewal) await api.patchSubscription(s.id, { next_renewal: rollForwardRenewal(s.next_renewal, s.cycle, today) });
    }, "Kept"),
    cancel: wantCancel,
    edit: (s: SubscriptionItem) => setSheet({ item: s }),
  };

  const sections = useMemo(() => groupSubscriptions(d?.items ?? []), [d]);

  if (check) return <StillUsing items={d ? stillUsingList(d.items, answered) : null} answered={answered} setAnswered={setAnswered} run={run} wantCancel={wantCancel} />;

  const t = d?.totals;
  const cardProps = { refs: ref, act, menuFor, setMenuFor };
  return (
    <div className="px-4 pb-8 pt-safe">
      <Link to="/settings" className="tap inline-flex items-center pt-3 text-sm text-accent">‹ Settings</Link>
      <h1 className="pb-1 text-2xl font-bold">Subscriptions</h1>

      <section className="rounded-3xl bg-card p-4 shadow-sm" aria-label="Subscription totals">
        <p className="num text-3xl font-bold">{sgd(t?.monthly ?? 0)} <span className="text-base font-semibold text-muted">/ month</span><span className="text-base font-semibold text-muted"> · </span>{sgd(t?.yearly ?? 0)} <span className="text-base font-semibold text-muted">/ year</span></p>
        <p className="num mt-1 text-sm text-muted">Essentials {sgd(t?.essentials ?? 0)} · Lifestyle {sgd(t?.lifestyle ?? 0)}</p>
        <p className="text-xs text-muted">{t?.count ?? 0} {t?.count === 1 ? "subscription" : "subscriptions"} · monthly equivalents</p>
      </section>

      <div className="mt-3 flex gap-2">
        <button className={primaryBtn} onClick={() => setSheet({ item: null })}>Add subscription</button>
        <Link to="/subscriptions?check=1" className={`${softBtn} grid place-items-center`}>Still using?</Link>
      </div>

      {data.error && !d && <p className="py-6 text-center text-sm text-muted">Couldn't load subscriptions. Pull to refresh in a moment.</p>}
      {d && d.items.length === 0 && <p className="py-10 text-center text-sm text-muted">Nothing here yet. Add one, or let Okanary look through your history for charges that repeat.</p>}

      {sections.candidate.length > 0 && (
        <Section title="To confirm" hint="Charges that look like they repeat.">
          {sections.candidate.map((s) => (
            <article key={s.id} className="rounded-3xl bg-card p-4 shadow-sm">
              <p className="font-semibold">{candidateText(s)}</p>
              <p className="text-xs text-muted">{[ref.categoryMap.get(s.category_id ?? "")?.name, nextLine(s)].filter(Boolean).join(" · ")}</p>
              <div className="mt-2 flex gap-2">
                <button className="tap flex-1 rounded-xl bg-accent font-semibold text-accent-fg" onClick={() => void act.confirm(s)}>Yes</button>
                <button className="tap flex-1 rounded-xl border border-line text-sm font-medium" onClick={() => void act.notOne(s)}>Not one</button>
              </div>
            </article>
          ))}
        </Section>
      )}

      {sections.attention.length > 0 && (
        <Section title="Needs a look" hint="Worth a glance, nothing urgent.">
          {sections.attention.map((s) => <ItemCard key={s.id} s={s} {...cardProps} />)}
        </Section>
      )}

      {sections.active.length > 0 && (
        <Section title="Active">
          {sections.active.map((s) => <ItemCard key={s.id} s={s} {...cardProps} />)}
        </Section>
      )}

      {sections.cancelling.length > 0 && (
        <Section title="Cancelling" hint="You've said you want to cancel. Finish it with the service, then mark it cancelled.">
          {sections.cancelling.map((s) => <ItemCard key={s.id} s={s} {...cardProps} />)}
        </Section>
      )}

      {sections.ended.length > 0 && (
        <details className="mt-5">
          <summary className="tap flex cursor-pointer items-center text-sm font-semibold text-muted">Cancelled / dismissed ({sections.ended.length})</summary>
          <div className="mt-2 space-y-2">
            {sections.ended.map((s) => <ItemCard key={s.id} s={s} {...cardProps} />)}
          </div>
        </details>
      )}

      <button className="tap mt-5 w-full rounded-xl border border-line text-sm font-medium" onClick={() => void run(async () => { const r = await api.detectSubscriptions(); toast({ msg: r.added ? `Found ${r.added} new` : "No new subscriptions found" }); })}>Scan my history now</button>
      <p className="px-1 pt-3 text-center text-[11px] text-muted">Okanary can't cancel anything for you. "I want to cancel" opens the service's own page when it's known.</p>

      {sheet && <SubscriptionSheet item={sheet.item} catalogue={d?.catalogue ?? []} onClose={() => setSheet(null)} />}
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="mt-5">
      <h2 className="text-sm font-extrabold">{title}</h2>
      {hint && <p className="pb-1 text-xs text-muted">{hint}</p>}
      <div className="mt-1 space-y-2">{children}</div>
    </section>
  );
}

type Act = {
  confirm: (s: SubscriptionItem) => unknown; notOne: (s: SubscriptionItem) => unknown; accept: (s: SubscriptionItem) => unknown; review: (s: SubscriptionItem) => unknown;
  cancelled: (s: SubscriptionItem) => unknown; reactivate: (s: SubscriptionItem) => unknown; keep: (s: SubscriptionItem) => unknown; cancel: (s: SubscriptionItem) => unknown; edit: (s: SubscriptionItem) => unknown;
};

const chip = "tap rounded-full border px-3 text-[13px] font-bold";

/** Buttons that answer one flag line. Renewal reminders are information only. */
function FlagActions({ kind, s, act }: { kind: FlagKind; s: SubscriptionItem; act: Act }) {
  const btn = "tap rounded-full border border-line bg-card px-3 text-[13px] font-bold";
  if (kind === "price_change") return <><button className={`${btn} text-accent`} onClick={() => void act.accept(s)}>Accept new price</button><button className={btn} onClick={() => void act.review(s)}>Review</button></>;
  if (kind === "missing") return <><button className={btn} onClick={() => void act.cancelled(s)}>Mark cancelled</button><button className={btn} onClick={() => void act.keep(s)}>Keep</button></>;
  if (kind === "trial_ending") return <><button className={btn} onClick={() => void act.keep(s)}>Keep</button><button className={btn} onClick={() => void act.cancel(s)}>Cancel</button></>;
  return null;
}

function ItemCard({ s, refs, act, menuFor, setMenuFor }: { s: SubscriptionItem; refs: ReturnType<typeof useRefData>; act: Act; menuFor: string | null; setMenuFor: (id: string | null) => void }) {
  const ended = s.status === "cancelled" || s.status === "dismissed";
  const cancelling = s.status === "cancel_intended";
  const flags = ended ? [] : flagLines(s);
  const hint = monthlyHint(s.monthly_equivalent, s.cycle);
  const fx = sgdHint(s);
  const where = [s.account_id ? refs.accountMap.get(s.account_id)?.name : null, s.category_id ? refs.categoryMap.get(s.category_id)?.name : null].filter(Boolean).join(" · ");
  const open = menuFor === s.id;
  const menuItem = "tap block w-full px-4 text-left text-sm active:bg-line/40";
  const pick = (fn: () => unknown) => () => { setMenuFor(null); void fn(); };
  return (
    <article className={`relative rounded-3xl bg-card p-4 shadow-sm ${ended ? "opacity-70" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-semibold">{displayName(s)}{s.status === "trial" && <span className="ml-2 rounded-full bg-pill px-2 py-0.5 align-middle text-[11px] font-bold text-lifestyle-ink">Trial</span>}</p>
          <p className="text-xs text-muted">{[nextLine(s), where].filter(Boolean).join(" · ")}</p>
        </div>
        <div className="flex shrink-0 items-start gap-1">
          <div className="text-right">
            <p className="num text-lg font-bold">{itemPriceText(s)}</p>
            {(hint || fx) && <p className="num text-xs text-muted">{[fx, hint].filter(Boolean).join(" · ")}</p>}
          </div>
          <button className="tap -mr-2 grid place-items-center rounded-full px-2 text-lg text-muted" aria-label={`Actions for ${displayName(s)}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setMenuFor(open ? null : s.id)}>⋯</button>
        </div>
      </div>

      <p className="mt-1"><span className="rounded-full bg-bg px-2 py-0.5 text-[11px] font-bold text-muted">{sourceLabel(s.source)}</span></p>

      {flags.map((f) => (
        <div key={f.kind} className={`mt-2 rounded-2xl px-3 py-2 ${f.kind === "renewal_soon" || f.kind === "missing" ? "bg-bg" : "bg-pill"}`}>
          <p className={`text-sm ${f.kind === "price_change" || f.kind === "trial_ending" ? "font-semibold text-lifestyle-ink" : "text-fg"}`}>{f.text}</p>
          {f.kind !== "renewal_soon" && <div className="mt-1 flex flex-wrap gap-2"><FlagActions kind={f.kind} s={s} act={act} /></div>}
        </div>
      ))}

      {s.goal_impact && !ended && <p className="mt-2 text-xs text-muted">{s.goal_impact.text}</p>}

      {cancelling && (
        <div className="mt-2 flex flex-wrap gap-2">
          {s.cancel_url && <a href={s.cancel_url} target="_blank" rel="noopener noreferrer" className="tap grid place-items-center rounded-full border border-line px-3 text-[13px] font-bold text-accent">Open cancel page</a>}
          <button className="tap rounded-full border border-line px-3 text-[13px] font-bold" onClick={() => void act.cancelled(s)}>Mark cancelled</button>
          <button className="tap rounded-full border border-line px-3 text-[13px] font-bold" onClick={() => void act.keep(s)}>Keep</button>
        </div>
      )}

      {open && (
        <>
          <button aria-label="Close menu" className="fixed inset-0 z-10 cursor-default" onClick={() => setMenuFor(null)} />
          <div role="menu" className="absolute right-3 top-12 z-20 w-56 overflow-hidden rounded-2xl border border-line bg-card py-1 shadow-lg">
            <button role="menuitem" className={menuItem} onClick={pick(() => act.edit(s))}>Edit</button>
            {ended ? (
              <button role="menuitem" className={menuItem} onClick={pick(() => act.reactivate(s))}>Still subscribed</button>
            ) : (
              <>
                {!cancelling && <button role="menuitem" className={menuItem} onClick={pick(() => act.cancel(s))}>I want to cancel</button>}
                <button role="menuitem" className={menuItem} onClick={pick(() => act.cancelled(s))}>Mark cancelled</button>
                <button role="menuitem" className={menuItem} onClick={pick(() => act.keep(s))}>Keep</button>
              </>
            )}
          </div>
        </>
      )}
    </article>
  );
}

// ---------------------------------------------------------------- "Still using?" (?check=1)

function StillUsing({ items, answered, setAnswered, run, wantCancel }: {
  items: SubscriptionItem[] | null; answered: ReadonlySet<string>; setAnswered: (s: ReadonlySet<string>) => void;
  run: (fn: () => Promise<unknown>, msg?: string) => Promise<boolean>; wantCancel: (s: SubscriptionItem) => Promise<void>;
}) {
  const done = (id: string) => setAnswered(new Set([...answered, id]));
  const btn = "tap flex-1 rounded-xl border border-line text-sm font-medium";
  return (
    <div className="px-4 pb-8 pt-safe">
      <Link to="/subscriptions" className="tap inline-flex items-center pt-3 text-sm text-accent">‹ Subscriptions</Link>
      <h1 className="pb-1 text-2xl font-bold">Still using these?</h1>
      <p className="pb-2 text-sm text-muted">A quick look now and then is all this is. Nothing changes unless you say so.</p>
      {items === null && <p className="py-10 text-center text-sm text-muted">…</p>}
      {items && items.length === 0 && (
        <div className="py-10 text-center text-sm text-muted">
          <p>All checked. Thanks!</p>
          <Link to="/subscriptions" className="tap mt-2 inline-flex items-center font-semibold text-accent">See all subscriptions ›</Link>
        </div>
      )}
      <div className="space-y-2">
        {items?.map((s) => (
          <article key={s.id} className="rounded-3xl bg-card p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-semibold">{displayName(s)}</p>
                <p className="text-xs text-muted">{nextLine(s) ?? sourceLabel(s.source)}</p>
              </div>
              <div className="shrink-0 text-right">
                <p className="num text-lg font-bold">{itemPriceText(s)}</p>
                {monthlyHint(s.monthly_equivalent, s.cycle) && <p className="num text-xs text-muted">{monthlyHint(s.monthly_equivalent, s.cycle)}</p>}
              </div>
            </div>
            {s.goal_impact && <p className="mt-2 text-xs text-muted">{s.goal_impact.text}</p>}
            <div className="mt-2 flex gap-2">
              <button className={`${btn} bg-accent text-accent-fg`} onClick={() => void run(() => api.keepSubscription(s.id), "Kept").then((ok) => ok && done(s.id))}>Keep</button>
              <button className={btn} onClick={() => void wantCancel(s).then(() => done(s.id))}>Cancel</button>
              <button className={btn} onClick={() => void run(() => api.remindSubscriptionLater(s.id), "Okay, I'll ask again later").then((ok) => ok && done(s.id))}>Remind me later</button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- add / edit

function SubscriptionSheet({ item, catalogue, onClose }: { item: SubscriptionItem | null; catalogue: { key: string; name: string; category_id: string; cycle: Cycle }[]; onClose: () => void }) {
  const ref = useRefData();
  const toast = useToast();
  const today = sgtDate(new Date());
  const [f, setF] = useState<SubForm>(() => item
    ? {
        name: item.name, catalogueKey: item.catalogue_key, price: minorToDecimalString(item.amount_minor ?? item.expected_sgd_minor, item.amount_minor != null ? item.currency : "SGD"),
        currency: item.amount_minor != null ? item.currency : "SGD", cycle: item.cycle, nextRenewal: item.next_renewal ?? defaultNextRenewal(item.cycle, today),
        accountId: item.account_id ?? "", categoryId: item.category_id ?? "", trial: item.status === "trial", trialEnds: item.trial_ends ?? defaultTrialEnd(today),
      }
    : { name: "", catalogueKey: null, price: "", currency: "SGD", cycle: "monthly", nextRenewal: defaultNextRenewal("monthly", today), accountId: "", categoryId: "", trial: false, trialEnds: defaultTrialEnd(today) });
  const [renewalTouched, setRenewalTouched] = useState(!!item);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<SubForm>) => setF((x) => ({ ...x, ...p }));

  const accounts = ref.accounts.filter((a) => !a.archived || a.id === f.accountId);
  const categoryValue = ref.categories.some((c) => c.id === f.categoryId) ? f.categoryId : "";
  const chips = catalogue.length ? catalogue : [];

  function pickChip(key: string | null) {
    const c = chips.find((x) => x.key === key);
    if (!c) return set({ catalogueKey: null });
    set({
      catalogueKey: c.key, name: c.name, cycle: c.cycle, categoryId: ref.categories.some((x) => x.id === c.category_id) ? c.category_id : "",
      ...(renewalTouched ? {} : { nextRenewal: defaultNextRenewal(c.cycle, today) }),
    });
  }
  function pickCycle(cycle: Cycle) {
    set({ cycle, ...(renewalTouched ? {} : { nextRenewal: defaultNextRenewal(cycle, today) }) });
  }

  async function save() {
    const v = buildPayload({ ...f, categoryId: categoryValue }, item);
    if (typeof v === "string") return setError(v);
    setError(null);
    setBusy(true);
    try {
      if (item) {
        if (Object.keys(v.input).length > 0) await api.patchSubscription(item.id, v.input);
        toast({ msg: "Saved" });
      } else {
        const r = await api.createSubscription(v.input);
        toast({ msg: r.merged ? `Merged with the detected ${displayName({ name: r.name, source: "detected" })}` : "Added" });
      }
      invalidateAll();
      onClose();
    } catch (e) {
      setBusy(false);
      setError(`Couldn't save: ${errMsg(e)}`);
    }
  }

  return (
    <Sheet open onClose={onClose} title={item ? "Edit subscription" : "Add subscription"}>
      <div className="space-y-2 px-4 pb-4 pt-2">
        {!item && (
          <div className="flex flex-wrap gap-1.5" aria-label="Common services">
            {chips.map((c) => (
              <button key={c.key} type="button" className={`${chip} ${f.catalogueKey === c.key ? "border-accent bg-accent text-accent-fg" : "border-line bg-bg"}`} onClick={() => pickChip(c.key)}>{c.name}</button>
            ))}
            <button type="button" className={`${chip} ${f.catalogueKey === null ? "border-accent bg-accent text-accent-fg" : "border-line bg-bg"}`} onClick={() => pickChip(null)}>Other</button>
          </div>
        )}

        <label className="block text-xs text-muted">Name
          <input className={field} value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Netflix" />
        </label>

        <div className="flex gap-2">
          <label className="block min-w-0 flex-1 text-xs text-muted">{f.trial ? "Price after the trial" : "Price"}
            <input className={field} inputMode="decimal" value={f.price} onChange={(e) => set({ price: e.target.value })} placeholder="e.g. 11.98" />
          </label>
          <label className="block w-24 shrink-0 text-xs text-muted">Currency
            <select className={field} value={f.currency} onChange={(e) => set({ currency: e.target.value })}>
              {SUPPORTED_CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
        </div>

        <label className="block text-xs text-muted">Billed
          <select className={field} value={f.cycle} onChange={(e) => pickCycle(e.target.value as Cycle)}>
            {CYCLE_LIST.map((c) => <option key={c} value={c}>{CYCLE_LABEL[c]}</option>)}
          </select>
        </label>

        {!f.trial && (
          <label className="block text-xs text-muted">Next renewal
            <input type="date" className={field} value={f.nextRenewal} onChange={(e) => { setRenewalTouched(true); set({ nextRenewal: e.target.value }); }} />
          </label>
        )}

        <label className="block text-xs text-muted">Card
          <select className={field} value={f.accountId} onChange={(e) => set({ accountId: e.target.value })}>
            <option value="">No card chosen</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.last4 ? ` ·· ${a.last4}` : ""}</option>)}
          </select>
        </label>

        <label className="block text-xs text-muted">Category
          <select className={field} value={categoryValue} onChange={(e) => set({ categoryId: e.target.value })}>
            <option value="">{item ? "Keep as is" : "Default for this service"}</option>
            {ref.groups.map((g) => (
              <optgroup key={g.id} label={g.name}>
                {ref.categories.filter((c) => c.group_id === g.id && !c.archived).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </optgroup>
            ))}
          </select>
        </label>

        <label className="tap flex items-center gap-2 text-sm">
          <input type="checkbox" className="h-5 w-5" checked={f.trial} onChange={(e) => set({ trial: e.target.checked })} />
          Free trial
        </label>
        {f.trial && (
          <label className="block text-xs text-muted">Trial ends
            <input type="date" className={field} value={f.trialEnds} min={today} onChange={(e) => set({ trialEnds: e.target.value })} />
            <span className="mt-0.5 block text-[11px]">Okanary reminds you 2 days before. The first charge is counted from that day.</span>
          </label>
        )}

        {error && <p role="alert" className="px-1 text-xs font-semibold text-lifestyle-ink">{error}</p>}
        <div className="flex gap-2 pt-1">
          <button disabled={busy} onClick={() => void save()} className={primaryBtn}>{item ? "Save" : "Add"}</button>
        </div>
      </div>
    </Sheet>
  );
}

/** A week from today: a typical free-trial length when none is typed yet. */
const defaultTrialEnd = (today: string) => defaultNextRenewal("weekly", today);
