import { useCallback, useEffect, useRef, useState } from "react";

/** Tiny shared-invalidation data hook (stale-while-revalidate). Single user, small data: no query library needed. */
const listeners = new Set<() => void>();
export const invalidateAll = () => listeners.forEach((l) => l());
const cache = new Map<string, unknown>();

export function useResource<T>(key: string, fetcher: () => Promise<T>) {
  const [data, setData] = useState<T | undefined>(cache.get(key) as T | undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(data === undefined);
  const fetchRef = useRef(fetcher);
  fetchRef.current = fetcher;

  const load = useCallback(async () => {
    try {
      const v = await fetchRef.current();
      cache.set(key, v);
      setData(v);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [key]);

  useEffect(() => {
    setData(cache.get(key) as T | undefined);
    setLoading(cache.get(key) === undefined);
    void load();
    listeners.add(load);
    const onVis = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      listeners.delete(load);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [key, load]);

  return { data, error, loading, reload: load };
}
