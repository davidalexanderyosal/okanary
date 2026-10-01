import { useMemo } from "react";
import type { Account, Category } from "@okanary/core";
import { api } from "./api";
import { useResource } from "./data";

export function useRefData() {
  const cats = useResource("categories", api.categories);
  const accts = useResource("accounts", api.accounts);
  const categoryMap = useMemo(() => new Map<string, Category>((cats.data?.categories ?? []).map((c) => [c.id, c])), [cats.data]);
  const accountMap = useMemo(() => new Map<string, Account>((accts.data ?? []).map((a) => [a.id, a])), [accts.data]);
  return {
    groups: cats.data?.groups ?? [],
    categories: cats.data?.categories ?? [],
    usage: cats.data?.usage ?? {},
    accounts: accts.data ?? [],
    categoryMap, accountMap,
    ready: !!cats.data && !!accts.data,
  };
}
