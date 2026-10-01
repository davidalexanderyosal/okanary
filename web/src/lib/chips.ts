import type { Category, CategoryGroup } from "@okanary/core";

/** Category chip order: most used first; ties favour Lifestyle (the point of the app), then other spend groups, then non-spend. */
export function chipOrder(categories: Category[], groups: CategoryGroup[], usage: Record<string, number>): Category[] {
  const gm = new Map(groups.map((g) => [g.id, g]));
  const rank = (g?: CategoryGroup) => (g?.id === "lifestyle" ? 0 : g?.counts_as_spend ? 1 : 2);
  return categories
    .filter((c) => !c.archived)
    .sort((a, b) => {
      const ga = gm.get(a.group_id), gb = gm.get(b.group_id);
      return (usage[b.id] ?? 0) - (usage[a.id] ?? 0) || rank(ga) - rank(gb) || (ga?.sort ?? 0) - (gb?.sort ?? 0) || a.sort - b.sort;
    });
}
