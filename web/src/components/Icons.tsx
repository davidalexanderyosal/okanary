import type { ReactNode } from "react";

const PATHS: Record<string, ReactNode> = {
  home: <path d="M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z" />,
  list: <path d="M5 7h14M5 12h14M5 17h9" />,
  pie: <><path d="M12 4a8 8 0 1 0 8 8h-8z" /><path d="M15 3.5A8 8 0 0 1 20.5 9H15z" /></>,
  bars: <path d="M6 19V11M12 19V5M18 19v-6" />,
  money: <><path d="M4 8a2 2 0 0 1 2-2h11v3" /><path d="M4 8v9a2 2 0 0 0 2 2h12a1 1 0 0 0 1-1V10a1 1 0 0 0-1-1H6a2 2 0 0 1-2-1z" /><path d="M15.5 14h.1" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  gear: <><circle cx="12" cy="12" r="3" /><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8" /></>,
  // category-group glyphs
  essentials: <path d="M4 11l8-7 8 7v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />,
  lifestyle: <><path d="M5 9h11v6a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V9z" /><path d="M16 11h2a2 2 0 0 1 0 4h-2" /><path d="M8 3v3M12 3v3" /></>,
  savings: <><circle cx="12" cy="12" r="8" /><path d="M12 8v8M9.5 10.2c0-1 1-1.7 2.5-1.7s2.5.7 2.5 1.7-1 1.5-2.5 1.8-2.5.8-2.5 1.8 1 1.7 2.5 1.7 2.5-.7 2.5-1.7" /></>,
  income: <path d="M12 5v13M6 13l6 6 6-6" />,
  transfers: <path d="M5 8h13l-3-3M19 16H6l3 3" />,
  uncategorised: <><circle cx="12" cy="12" r="8" /><path d="M9.7 9.5a2.4 2.4 0 1 1 3.4 2.2c-.7.4-1.1.8-1.1 1.6M12 16.5v.1" /></>,
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, className = "h-5 w-5", strokeWidth = 2 }: { name: IconName | string; className?: string; strokeWidth?: number }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name] ?? PATHS.uncategorised}
    </svg>
  );
}

/** Tinted chip colours per category group (matching the palette: peach, sky, mint, lilac). */
export const GROUP_TINT: Record<string, { bg: string; fg: string }> = {
  essentials: { bg: "rgb(140 203 255 / 0.28)", fg: "var(--tint-sky)" },
  lifestyle: { bg: "rgb(255 180 138 / 0.3)", fg: "var(--tint-peach)" },
  savings: { bg: "rgb(127 221 180 / 0.3)", fg: "var(--tint-mint)" },
  income: { bg: "rgb(196 181 253 / 0.35)", fg: "var(--tint-lilac)" },
  transfers: { bg: "rgb(150 160 190 / 0.25)", fg: "var(--muted)" },
  uncategorised: { bg: "rgb(150 160 190 / 0.25)", fg: "var(--muted)" },
};
export const groupTint = (id: string | null | undefined) => GROUP_TINT[id ?? "uncategorised"] ?? GROUP_TINT.uncategorised!;
