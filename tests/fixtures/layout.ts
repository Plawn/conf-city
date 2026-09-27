import type { ResolvedLink, ResolvedNode } from "@/domain/types";

/** Fixture builders shared by the layout tests: a city of `n` apps, links by id. */
export function city(
  cityId: string,
  ids: string[],
  links: Record<string, string[]> = {},
): ResolvedNode[] {
  return ids.map((id) => ({ id, cityId, type: "app", label: id, links: links[id] ?? [] }));
}

export function intraLinks(cityId: string, pairs: [string, string][]): ResolvedLink[] {
  return pairs.map(([a, b]) => ({
    fromNodeId: a,
    fromCityId: cityId,
    toNodeId: b,
    toCityId: cityId,
    interCity: false,
  }));
}

export function interLink(from: [string, string], to: [string, string]): ResolvedLink {
  return {
    fromCityId: from[0],
    fromNodeId: from[1],
    toCityId: to[0],
    toNodeId: to[1],
    interCity: true,
  };
}

export function grid(cityId: string, w: number, h: number): ResolvedNode[] {
  const ids: string[] = [];
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      ids.push(`n${i}${j}`);
    }
  }
  return city(cityId, ids);
}
