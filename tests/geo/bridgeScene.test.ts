import { expect, test } from "bun:test";
import {
  bridgeOverlays,
  deckExits,
  visibleBridges,
  visibleShore,
  worldExtent,
} from "@/geo/bridgeScene";
import { deckWidth } from "@/geo/drivable";
import { layoutWorld } from "@/layout/layoutWorld";
import { EMPTY_INFRA } from "@/store/mobilityStore";
import { grid, interLink, intraLinks } from "../fixtures/layout";

const world = layoutWorld(
  ["a", "b"],
  [...grid("a", 3, 2), ...grid("b", 2, 2)],
  [
    ...intraLinks("a", [["n00", "n21"]]),
    interLink(["a", "n10"], ["b", "n01"]),
    interLink(["a", "n21"], ["b", "n11"]),
  ],
);
const both = new Set(["a", "b"]);

test("each bridge opens one exit per shore, as wide as its deck", () => {
  const exits = deckExits(world, EMPTY_INFRA);
  const [headA, headB] = world.bridges[0]!.waterSpan;
  expect(exits.get("a")).toEqual([{ at: headA, toward: headB, halfWidth: deckWidth() / 2 }]);
  expect(exits.get("b")).toEqual([{ at: headB, toward: headA, halfWidth: deckWidth() / 2 }]);
  expect(deckExits(undefined, EMPTY_INFRA).size).toBe(0);
});

test("a bridge shows only when both its cities do, and its overlay rides above it", () => {
  const shown = visibleBridges(world, both, EMPTY_INFRA);
  expect(shown).toHaveLength(1);
  expect(visibleBridges(world, new Set(["a"]), EMPTY_INFRA)).toEqual([]);
  const overlays = bridgeOverlays(shown);
  expect(overlays).toHaveLength(shown[0]!.crossings.length);
  const path = shown[0]!.crossings[0]!.path.points;
  const lifted = overlays[0]!.points;
  expect(lifted).toHaveLength(path.length);
  expect(lifted[0]![1]).toBeGreaterThan(path[0]![1]);
  expect(lifted[0]![0]).toBe(path[0]![0]);
});

test("the extent covers every island, never below the small-world floor", () => {
  expect(worldExtent(undefined)).toBe(60);
  const extent = worldExtent(world);
  for (const c of world.cities.values()) {
    expect(extent).toBeGreaterThanOrEqual(Math.abs(c.bounds.cx) + c.bounds.width / 2);
  }
});

test("hidden cities leave no shore", () => {
  expect(visibleShore(world, new Set())).toBeUndefined();
  expect(visibleShore(undefined, both)).toBeUndefined();
  expect(visibleShore(world, both)).toBeDefined();
});
