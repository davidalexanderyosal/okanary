import type { Pace } from "@okanary/core";
import { MiniCanary } from "./Mascot";

const STATE_COLOR: Record<Pace["state"], string> = { under: "var(--savings)", on: "var(--savings)", over: "var(--peach)", exceeded: "var(--danger)" };

/** Progress toward a budget with a marker for "where you should be by today". */
export function PaceBar({ pace, color }: { pace: Pace; color?: string }) {
  const fill = Math.min(100, pace.pctSpent);
  const marker = Math.min(100, pace.pctExpected);
  return (
    <div className="relative mt-3" role="progressbar" aria-valuenow={pace.pctSpent} aria-valuemin={0} aria-valuemax={100} aria-label={`${pace.pctSpent}% of budget spent, pace marker at ${pace.pctExpected}%`}>
      <div className="h-3 overflow-hidden rounded-full bg-line">
        <div className="h-full rounded-full transition-[width]" style={{ width: `${fill}%`, background: color ?? STATE_COLOR[pace.state] }} />
      </div>
      <div className="absolute -top-1 h-5 w-0.5 rounded bg-fg" style={{ left: `calc(${marker}% - 1px)` }} title="Expected by today" />
    </div>
  );
}

/**
 * Home's receipt-style pace line: a dotted track, a dashed fill and a little canary riding the end of what's spent.
 * The dashed marker is where you should be by today.
 */
export function ReceiptPaceBar({ pace, marker: markerLabel, soft }: {
  pace: Pace;
  /** replaces the month-flavoured wording, e.g. { subject: "this week's allowance", marker: "Day 3 of 7" } for the weekly bar */
  marker?: { subject: string; marker: string };
  /** amber instead of red once the budget is exceeded (never shame an overspent week) */
  soft?: boolean;
}) {
  const fill = Math.min(100, pace.pctSpent);
  const marker = Math.min(100, pace.pctExpected);
  const dash = soft && pace.state === "exceeded" ? "var(--peach)" : STATE_COLOR[pace.state];
  const label = markerLabel
    ? `${pace.pctSpent}% of ${markerLabel.subject} spent, marker at ${markerLabel.marker}`
    : `${pace.pctSpent}% of budget spent, pace marker at ${pace.pctExpected}%`;
  return (
    <div className="relative mb-1 mt-5 h-[10px]" role="progressbar" aria-valuenow={pace.pctSpent} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <div className="absolute inset-0" style={{ background: "radial-gradient(circle, var(--edge) 1.8px, transparent 2.2px) 0 50% / 9px 10px repeat-x" }} />
      <div className="absolute bottom-[2px] left-0 top-[2px] transition-[width]" style={{ width: `${fill}%`, background: `repeating-linear-gradient(90deg, ${dash} 0 7px, transparent 7px 10px)` }}>
        <MiniCanary className="absolute -right-3.5 -top-[17px] h-7 w-7" />
      </div>
      <div className="absolute -top-[3px] h-4 border-l-2 border-dashed border-fg opacity-55" style={{ left: `calc(${marker}% - 1px)` }} title={markerLabel?.marker ?? "Expected by today"} />
    </div>
  );
}

export const paceText: Record<Pace["state"], string> = { under: "Under pace", on: "On pace", over: "Ahead of pace", exceeded: "Over budget" };
export const paceTextColor: Record<Pace["state"], string> = { under: "text-good", on: "text-good", over: "text-lifestyle-ink", exceeded: "text-danger" };
