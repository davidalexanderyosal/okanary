import { sgtMonth } from "@okanary/core";
export const currentMonth = () => sgtMonth(new Date());
export const todaySgt = () => new Date().toISOString();
