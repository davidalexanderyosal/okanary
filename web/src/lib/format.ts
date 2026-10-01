import { addMonths, formatMoney, sgtDate, sgtParts } from "@okanary/core";

export const sgd = (minor: number, compact = true) => formatMoney(minor, "SGD", { compact });

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function monthLabel(month: string): string {
  const [y, m] = month.split("-");
  return `${MONTHS[+m! - 1]} ${y}`;
}

export function dayLabel(utcIso: string, today: string): string {
  const d = sgtDate(utcIso);
  if (d === today) return "Today";
  const { year, month, day } = sgtParts(utcIso);
  const dow = DAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${dow} ${day} ${MONTHS[month - 1]}`;
}

export function timeLabel(utcIso: string): string {
  const p = sgtParts(utcIso);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

export { addMonths };
