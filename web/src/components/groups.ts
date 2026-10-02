export const GROUP_COLOR: Record<string, string> = {
  essentials: "var(--essentials)",
  lifestyle: "var(--lifestyle)",
  savings: "var(--savings)",
  income: "var(--lilac)",
  transfers: "var(--muted)",
  uncategorised: "var(--muted)",
};
export const groupColor = (id: string | null | undefined) => GROUP_COLOR[id ?? "uncategorised"] ?? "var(--muted)";
