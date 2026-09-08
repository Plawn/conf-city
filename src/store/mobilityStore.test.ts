import { expect, test } from "bun:test";
import { useMobilityStore } from "./mobilityStore";

test("bridge construction widens both accesses without downgrading existing metros", () => {
  const s = useMobilityStore.getState();
  s.setWorld("bridge-access-regression");
  s.commit({ key: "city:a", kind: "metro", remaining: 0 });
  s.commit({ key: "bridge:a|b", kind: "bridge", remaining: 0, accessCities: ["a", "b"] });
  s.commit({ key: "city:a", kind: "roads", remaining: 0 });
  const infra = useMobilityStore.getState().worlds["bridge-access-regression"]!;
  expect(infra.cities).toEqual({ a: 2, b: 1 });
  expect(infra.bridges["a|b"]).toBe(true);
  s.reset();
  expect(useMobilityStore.getState().observations).toEqual([]);
});

test("saved bridges from the previous version gain wider accesses without resetting infrastructure", () => {
  const s = useMobilityStore.getState();
  s.setWorld("legacy-bridge-regression");
  s.commit({ key: "bridge:a|b", kind: "bridge", remaining: 0 });
  s.commit({ key: "city:a", kind: "metro", remaining: 0 });
  s.syncBridgeAccesses([{ key: "a|b", cityA: "a", cityB: "b" }]);
  const infra = useMobilityStore.getState().worlds["legacy-bridge-regression"]!;
  expect(infra.cities).toEqual({ a: 2, b: 1 });
  expect(infra.bridges["a|b"]).toBe(true);
  s.syncBridgeAccesses([{ key: "a|b", cityA: "a", cityB: "b" }]);
  expect(useMobilityStore.getState().worlds["legacy-bridge-regression"]).toBe(infra);
});
