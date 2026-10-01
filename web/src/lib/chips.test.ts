import { describe, expect, it } from "vitest";
import type { Category, CategoryGroup } from "@okanary/core";
import { chipOrder } from "./chips";
import { prettyMerchant } from "./format";

const g = (id: string, spend: number, sort: number): CategoryGroup => ({ id, name: id, counts_as_spend: spend, sort });
const c = (id: string, group_id: string, sort = 0, archived = 0): Category => ({ id, group_id, name: id, icon: null, color: null, sort, archived });

describe("chipOrder", () => {
  const groups = [g("essentials", 1, 1), g("lifestyle", 1, 2), g("savings", 0, 3)];
  const cats = [c("groceries", "essentials"), c("food", "lifestyle"), c("savings", "savings"), c("old", "lifestyle", 0, 1), c("coffee", "lifestyle", 1)];
  it("most used first, then Lifestyle, then other spend, then non-spend; archived hidden", () => {
    expect(chipOrder(cats, groups, {}).map((x) => x.id)).toEqual(["food", "coffee", "groceries", "savings"]);
    expect(chipOrder(cats, groups, { groceries: 9 }).map((x) => x.id)[0]).toBe("groceries");
  });
});

describe("prettyMerchant", () => {
  it("title-cases normalised names", () => {
    expect(prettyMerchant("YA KUN KAYA TOAST")).toBe("Ya Kun Kaya Toast");
    expect(prettyMerchant("H&M")).toBe("H&M");
    expect(prettyMerchant(null)).toBe("");
  });
});
