import type { UsualResult } from "@okanary/core";
import { sgd } from "./format";

/** 'amber' only for "above usual"; everything else is neutral (never red, never shaming). */
export type UsualTone = "neutral" | "amber";
export interface UsualText { text: string; tone: UsualTone }

export const NO_HISTORY_TEXT = "Not enough history yet";

/** " (based on N months)" when fewer than 3 complete months were averaged (empty otherwise, and with no history). */
export function basedOnNote(periodCount: number): string {
  if (periodCount <= 0 || periodCount >= 3) return "";
  return ` (based on ${periodCount} ${periodCount === 1 ? "month" : "months"})`;
}

/** Home, under the month total: "S$640 so far · 12% below your usual by day 14". */
export function monthUsualLine(r: UsualResult, day: number, monthsUsed: number): UsualText {
  const c = r.comparison;
  if (c.state === "no_history") return { text: NO_HISTORY_TEXT, tone: "neutral" };
  const how = c.state === "about" ? "about your usual" : `${c.pct != null ? `${Math.abs(c.pct)}% ` : ""}${c.state} your usual`;
  return { text: `${sgd(r.current)} so far · ${how} by day ${day}${basedOnNote(monthsUsed)}`, tone: c.state === "above" ? "amber" : "neutral" };
}

/** Lifestyle card: "Week: about usual" / "Week: S$40 above usual" / "Week: S$25 below usual"; null without history. */
export function weekUsualText(r: UsualResult): UsualText | null {
  const c = r.comparison;
  if (c.state === "no_history" || c.diff == null) return null;
  if (c.state === "about") return { text: "Week: about usual", tone: "neutral" };
  return { text: `Week: ${sgd(Math.abs(c.diff))} ${c.state} usual`, tone: c.state === "above" ? "amber" : "neutral" };
}

/** Reports row: "+S$40" / "−S$25" against usual (amber text only for increases). */
export function usualDiffText(r: UsualResult): UsualText {
  const c = r.comparison;
  if (c.state === "no_history" || c.diff == null) return { text: "–", tone: "neutral" };
  if (c.state === "about") return { text: "about usual", tone: "neutral" };
  return { text: `${c.diff > 0 ? "+" : "−"}${sgd(Math.abs(c.diff))}`, tone: c.state === "above" ? "amber" : "neutral" };
}

export const usualToneClass: Record<UsualTone, string> = { neutral: "text-muted", amber: "text-lifestyle-ink" };
