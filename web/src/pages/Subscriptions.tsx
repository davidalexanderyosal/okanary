import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { invalidateAll, useResource } from "../lib/data";
import { prettyMerchant, shortDate, sgd } from "../lib/format";
import { useRefData } from "../lib/refdata";
import { useToast } from "../components/Toast";

/** Detected recurring charges (spec §3.2): same merchant, ~monthly, similar amount. Confirm what's real, dismiss what isn't. */
export function Subscriptions() {
  const data = useResource("subscriptions", api.subscriptions);
  const ref = useRefData();
  const toast = useToast();
  const d = data.data;
  return (
    <div className="px-4 pb-8 pt-safe">
      <Link to="/settings" className="tap inline-flex items-center pt-3 text-sm text-accent">‹ Settings</Link>
      <h1 className="pb-1 text-2xl font-bold">Subscriptions</h1>
      <section className="rounded-3xl bg-card p-4 shadow-sm">
        <p className="text-sm text-muted">Recurring charges per month</p>
        <p className="num text-4xl font-bold">{sgd(d?.monthly_total ?? 0)}</p>
        <p className="text-xs text-muted">{sgd(d?.confirmed_total ?? 0)} confirmed · {sgd(Math.max(0, (d?.monthly_total ?? 0) - (d?.confirmed_total ?? 0)))} still to confirm · about {sgd((d?.monthly_total ?? 0) * 12)} a year</p>
      </section>

      <div className="mt-3 space-y-2">
        {d && d.items.length === 0 && <p className="py-10 text-center text-sm text-muted">Nothing detected yet. Okanary looks for the same merchant charging a similar amount about monthly, at least 3 times.</p>}
        {d?.items.map((s) => (
          <article key={s.id} className="rounded-3xl bg-card p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-semibold">{prettyMerchant(s.merchant)}</p>
                <p className="text-xs text-muted">{s.category_id ? ref.categoryMap.get(s.category_id)?.name : "Uncategorised"}{s.next_expected ? ` · next around ${shortDate(s.next_expected)}` : ""}</p>
              </div>
              <p className="num shrink-0 text-lg font-bold">{sgd(s.expected_amount_sgd_minor ?? 0)}<span className="text-xs font-normal text-muted">/mo</span></p>
            </div>
            <div className="mt-2 flex gap-2">
              {s.confirmed_by_user ? (
                <span className="tap flex items-center text-sm font-medium text-savings">✓ Confirmed</span>
              ) : (
                <button className="tap flex-1 rounded-xl bg-accent font-semibold text-accent-fg" onClick={() => void api.confirmSubscription(s.id).then(invalidateAll)}>Yes, it's a subscription</button>
              )}
              <button className="tap rounded-xl border border-line px-4 text-sm" onClick={() => void api.dismissSubscription(s.id).then(() => { invalidateAll(); toast({ msg: "Dismissed" }); })}>Not one</button>
            </div>
          </article>
        ))}
      </div>
      <button className="tap mt-4 w-full rounded-xl border border-line text-sm font-medium" onClick={() => void api.detectSubscriptions().then((r) => { invalidateAll(); toast({ msg: r.added ? `Found ${r.added} new` : "No new subscriptions found" }); })}>Scan my history now</button>
    </div>
  );
}
