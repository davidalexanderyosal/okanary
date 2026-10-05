import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useResource } from "../lib/data";
import { sgd } from "../lib/format";

/** Compact "Subscriptions S$X/mo ›" row linking into the hub from the Money pages. */
export function SubscriptionsLink({ className = "" }: { className?: string }) {
  const t = useResource("subscriptions", api.subscriptions).data?.totals;
  return (
    <Link to="/subscriptions" className={`tap flex items-center justify-between rounded-2xl bg-card px-4 text-sm font-semibold shadow-sm ${className}`}>
      <span>Subscriptions{t ? <span className="num ml-2 font-normal text-muted">{sgd(t.monthly)}/mo</span> : null}</span>
      <span className="text-muted">›</span>
    </Link>
  );
}
