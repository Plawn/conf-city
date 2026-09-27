import { vecKey } from "@/layout/geometry";
import type { RoadNetwork, Vec2 } from "@/layout/types";

const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function toPolyline(p: Vec2, ring: Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2));
    best = Math.min(best, dist(p, [a[0] + dx * t, a[1] + dz * t]));
  }
  return best;
}

/** How well a city's streets hang together: the numbers the topology rules bound. */
export function topology(roads: RoadNetwork) {
  const ringKeys = new Set(roads.ring.map(vecKey));
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    const p = parent.get(k) ?? k;
    if (p === k) {
      return k;
    }
    const r = find(p);
    parent.set(k, r);
    return r;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));
  for (const s of roads.segments) {
    const keys = s.points.map(vecKey);
    for (const k of keys) {
      parent.set(k, parent.get(k) ?? k);
    }
    for (let i = 1; i < keys.length; i++) {
      union(keys[i - 1]!, keys[i]!);
    }
  }
  const ringRoots = new Set([...ringKeys].filter((k) => parent.has(k)).map(find));
  const detached = new Set<string>();
  for (const s of roads.segments) {
    const root = find(vecKey(s.points[0]!));
    if (!ringRoots.has(root)) {
      detached.add(root);
    }
  }
  const onRing = roads.roundabouts.filter((r) => ringKeys.has(vecKey(r.center)));
  const lattice = roads.roundabouts.filter((r) => !ringKeys.has(vecKey(r.center)));
  let minStub = Infinity;
  for (const s of roads.segments) {
    const end = s.points.at(-1)!;
    if (!s.ring && ringKeys.has(vecKey(end))) {
      minStub = Math.min(minStub, dist(s.points[0]!, end));
    }
  }
  let headGap = Infinity;
  for (let i = 0; i < onRing.length; i++) {
    for (let j = i + 1; j < onRing.length; j++) {
      headGap = Math.min(headGap, dist(onRing[i]!.center, onRing[j]!.center));
    }
  }
  let mouthToHead = Infinity;
  for (const d of roads.driveways) {
    if (!ringKeys.has(vecKey(d.mouth))) {
      continue;
    }
    for (const r of onRing) {
      if (r.center !== d.mouth) {
        mouthToHead = Math.min(mouthToHead, dist(d.mouth, r.center));
      }
    }
  }
  return {
    detached: detached.size,
    minStub,
    headGap,
    mouthToHead,
    latticeToRing: Math.min(Infinity, ...lattice.map((r) => toPolyline(r.center, roads.ring))),
  };
}
