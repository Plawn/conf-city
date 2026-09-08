import { expect, test } from "bun:test";
import {
  advanceConstruction,
  type Construction,
  type ConstructionObservation,
  type Infrastructure,
} from "./mobility";

test("short spikes never construct; sustained occupancy builds then persists", () => {
  const elapsed = new Map<string, ConstructionObservation>();
  const jobs: Construction[] = [];
  const infra: Infrastructure = { cities: {}, bridges: {} };
  advanceConstruction(elapsed, jobs, infra, { "city:a": 1 }, 19);
  expect(jobs).toHaveLength(0);
  advanceConstruction(elapsed, jobs, infra, { "city:a": 0.2 }, 6);
  advanceConstruction(elapsed, jobs, infra, { "city:a": 1 }, 19);
  expect(jobs).toHaveLength(0);
  advanceConstruction(elapsed, jobs, infra, { "city:a": 1 }, 1);
  expect(jobs[0]!.kind).toBe("roads");
  expect(advanceConstruction(elapsed, jobs, infra, { "city:a": 0 }, 5).completed).toHaveLength(1);
  infra.cities.a = 1;
  advanceConstruction(elapsed, jobs, infra, { "city:a": 1 }, 44);
  expect(jobs).toHaveLength(0);
  advanceConstruction(elapsed, jobs, infra, { "city:a": 1 }, 1);
  expect(jobs[0]!.kind).toBe("metro");
  advanceConstruction(elapsed, jobs, infra, { "city:a": 0 }, 5);
  infra.cities.a = 2;
  advanceConstruction(elapsed, jobs, infra, { "city:a": 1 }, 300);
  expect(jobs).toHaveLength(0);
  expect(infra.cities.a).toBe(2);
});

test("a bridge is widened once and city jobs are independent", () => {
  const elapsed = new Map<string, ConstructionObservation>();
  const jobs: Construction[] = [];
  const infra: Infrastructure = { cities: {}, bridges: {} };
  advanceConstruction(elapsed, jobs, infra, { "bridge:a|b": 1, "city:a": 0.1 }, 20);
  expect(jobs).toHaveLength(1);
  expect(jobs[0]!.kind).toBe("bridge");
  advanceConstruction(elapsed, jobs, infra, { "bridge:a|b": 1 }, 5);
  infra.bridges["a|b"] = true;
  advanceConstruction(elapsed, jobs, infra, { "bridge:a|b": 1 }, 100);
  expect(jobs).toHaveLength(0);
});
