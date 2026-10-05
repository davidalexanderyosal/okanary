import { useState } from "react";
import { api, type GoalContribution, type GoalView } from "../lib/api";
import { invalidateAll } from "../lib/data";
import { sgd } from "../lib/format";
import { chipClass, pledgeLabel, statusChip } from "../lib/goals";
import { useToast } from "./Toast";

export function StatusChip({ goal }: { goal: Pick<GoalView, "status"> }) {
  const c = statusChip(goal.status);
  return <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-extrabold ${chipClass[c.tone]}`}>{c.text}</span>;
}

/** An open pledge with its Transferred / Skip buttons. Okanary can't move money: David does, then taps Transferred. */
export function PledgeRow({ pledge, goalLabel, highlight, anchorId }: { pledge: GoalContribution; goalLabel?: string; highlight?: boolean; anchorId?: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function act(kind: "transfer" | "skip") {
    setBusy(true);
    try {
      await (kind === "transfer" ? api.transferPledge(pledge.id) : api.skipPledge(pledge.id));
      invalidateAll();
      toast({ msg: kind === "transfer" ? "Marked as moved. Nice one." : "Skipped. No worries." });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.startsWith("409")) invalidateAll(); // already handled elsewhere (e.g. from the notification)
      toast({ msg: msg.startsWith("409") ? "That one was already handled." : `Couldn't save: ${msg}` });
    } finally {
      setBusy(false);
    }
  }
  const btn = "tap rounded-full px-3 text-xs font-extrabold disabled:opacity-50";
  return (
    <div
      id={anchorId ? `pledge-${pledge.id}` : undefined}
      className={`flex items-center justify-between gap-2 rounded-2xl px-3 py-1.5 ${highlight ? "bg-pill ring-2 ring-accent" : "bg-bg"}`}
    >
      <div className="min-w-0">
        <p className="num text-sm">{sgd(pledge.amount_sgd_minor)}{goalLabel && <span className="font-sans font-semibold"> to {goalLabel}</span>}</p>
        <p className="truncate text-[11px] text-muted">{pledgeLabel(pledge)}</p>
      </div>
      <div className="flex shrink-0 gap-1.5">
        <button disabled={busy} className={`${btn} bg-sun text-sun-fg shadow-[0_2px_0_var(--sun-edge)] active:translate-y-[2px] active:shadow-none`} onClick={() => void act("transfer")}>Transferred</button>
        <button disabled={busy} className={`${btn} border border-line text-muted active:bg-line/40`} onClick={() => void act("skip")}>Skip</button>
      </div>
    </div>
  );
}
