import { useEffect, useRef } from "react";

export interface HashState {
  cities?: string[];
  node?: string;
}

export function readHash(): HashState {
  const raw = window.location.hash.replace(/^#/, "");
  if (!raw) {
    return {};
  }
  const params = new URLSearchParams(raw);
  const cities = params.get("cities");
  const node = params.get("node");
  return {
    cities: cities ? cities.split(",").filter(Boolean) : undefined,
    node: node || undefined,
  };
}

/** Mirrors `state` into the URL hash (debounced, replaceState — no history spam). */
export function useHashState(state: HashState, enabled = true) {
  const timer = useRef<number | null>(null);
  const cities = state.cities?.join(",") ?? "";
  const node = state.node ?? "";
  useEffect(() => {
    if (!enabled) {
      return;
    }
    if (timer.current) {
      window.clearTimeout(timer.current);
    }
    timer.current = window.setTimeout(() => {
      const params = new URLSearchParams();
      if (cities) {
        params.set("cities", cities);
      }
      if (node) {
        params.set("node", node);
      }
      const next = params.toString();
      const url = next ? `#${next}` : window.location.pathname + window.location.search;
      history.replaceState(null, "", url);
    }, 300);
    return () => {
      if (timer.current) {
        window.clearTimeout(timer.current);
      }
    };
  }, [cities, node, enabled]);
}
