import { dayOfWeek } from "@okanary/core";
import { sgd } from "./format";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Short weekday name of the next week's first day, i.e. the day after the week's last date ('YYYY-MM-DD'). */
export function nextResetDay(weekEndDate: string): string {
  return DAYS[(dayOfWeek(weekEndDate) + 1) % 7]!;
}

/** Home headline: "This week: S$X left of S$Y · resets Mon", or "This week: S$Z over · resets Mon" (neutral wording). */
export function weekHeadline(i: { total: number; spent: number; endDate: string }): string {
  const reset = nextResetDay(i.endDate);
  return i.spent > i.total
    ? `This week: ${sgd(i.spent - i.total)} over · resets ${reset}`
    : `This week: ${sgd(i.total - i.spent)} left of ${sgd(i.total)} · resets ${reset}`;
}

/** Smaller month line below the week: "Month: S$642 / S$900", or just the spend when no monthly budget is set. */
export function monthLine(month: { budget: number | null; spent: number }): string {
  return month.budget && month.budget > 0 ? `Month: ${sgd(month.spent)} / ${sgd(month.budget)}` : `Month: ${sgd(month.spent)}`;
}

/** Note beside "Safe to spend today": "S$150 over 4 days". */
export function safeNote(i: { left: number; daysLeft: number }): string {
  return `${sgd(Math.max(i.left, 0))} over ${i.daysLeft} ${i.daysLeft === 1 ? "day" : "days"}`;
}
