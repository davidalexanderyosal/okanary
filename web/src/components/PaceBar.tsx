import type { Pace } from "@okanary/core";

const STATE_COLOR: Record<Pace["state"], string> = { under: "var(--savings)", on: "var(--savings)", over: "var(--lifestyle)", exceeded: "var(--danger)" };

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

export const paceText: Record<Pace["state"], string> = { under: "Under pace", on: "On pace", over: "Ahead of pace", exceeded: "Over budget" };
export const paceTextColor: Record<Pace["state"], string> = { under: "text-savings", on: "text-savings", over: "text-lifestyle", exceeded: "text-danger" };
