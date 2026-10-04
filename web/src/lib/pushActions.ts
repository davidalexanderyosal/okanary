/**
 * Pure helpers for the service worker's goal-pledge push actions (kept out of sw.ts so they can be unit tested).
 * The push payload carries `actions` (comma list, e.g. "transfer,skip") and `pledge` (a goal_contributions id).
 */

export interface NotificationActionDef { action: "transfer" | "skip"; title: string }

const TITLES: Record<NotificationActionDef["action"], string> = { transfer: "Transferred", skip: "Skip" };

/** "transfer,skip" -> two buttons. Only with a pledge id; unknown names are ignored. */
export function notificationActions(actions: string | undefined, pledge: string | undefined): NotificationActionDef[] {
  if (!actions || !pledge) return [];
  const out: NotificationActionDef[] = [];
  for (const raw of actions.split(",")) {
    const a = raw.trim();
    if ((a === "transfer" || a === "skip") && !out.some((o) => o.action === a)) out.push({ action: a, title: TITLES[a] });
  }
  return out;
}

/** The API call behind an action button, or null for a body click / unknown action / missing pledge. */
export function actionRequest(action: string | undefined, pledge: string | undefined): { path: string; method: "POST" } | null {
  if (!pledge || (action !== "transfer" && action !== "skip")) return null;
  return { path: `/api/goal-contributions/${encodeURIComponent(pledge)}/${action}`, method: "POST" };
}

/** 2xx is done; 409 means it was already handled (e.g. from the app). Anything else falls back to opening the app. */
export const actionHandled = (status: number): boolean => (status >= 200 && status < 300) || status === 409;
