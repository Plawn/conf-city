import { expect, test } from "bun:test";
import { createMobilityEngine } from "@/components/mobility/engine";
import {
  advanceMetro,
  createMetroFleet,
  metroSchedule,
  reconfigureMetroFleet,
  STATIONS,
  stationDwellRemaining,
  stationDwellStop,
  TRAINS,
  WAGON_SPACING,
} from "@/components/mobility/metro";
import { createPose, projectTrajectory, sampleTrajectory } from "@/components/mobility/trajectory";
import { circle } from "../../fixtures/trajectory";

test("metro dwells for six seconds, reaches each station exactly and repeats", () => {
  const route = circle();
  const fleet = createMetroFleet(route);
  advanceMetro(fleet, 6);
  expect(fleet.distances[0]).toBe(0);
  advanceMetro(fleet, 24);
  expect(fleet.distances[0]).toBeCloseTo(route.total / 3, 7);
  advanceMetro(fleet, 6);
  expect(fleet.distances[0]).toBeCloseTo(route.total / 3, 7);
  advanceMetro(fleet, 54);
  expect(fleet.distances[0]).toBeCloseTo(0, 7);
  const initial = createMetroFleet(route);
  expect(fleet.distances[1]).toBeCloseTo(initial.distances[1]!, 7);
});

test.each([30, 60, 144])("shared clock keeps the metro timetable at %i display Hz", (hz) => {
  const fleet = createMetroFleet(circle());
  const engine = createMobilityEngine();
  engine.register({ step: (dt) => advanceMetro(fleet, dt), render: () => {} });
  for (let i = 0; i < hz * 186; i++) {
    engine.advance(1 / hz);
  }
  expect(fleet.distances[0]).toBeCloseTo(0, 5);
  expect(fleet.elapsed).toBeCloseTo(186, 7);
});

test("each wagon has its own pose and fixed distance spacing on any circuit size", () => {
  for (const radius of [2, 20]) {
    const route = circle(radius);
    const fleet = createMetroFleet(route);
    const rear = fleet.poses[1]!;
    const expected = sampleTrajectory(route, -WAGON_SPACING, createPose());
    expect(rear.x).toBeCloseTo(expected.x, 8);
    expect(rear.z).toBeCloseTo(expected.z, 8);
    expect(rear.fx).not.toBeCloseTo(fleet.poses[0]!.fx, 4);
    const before = { ...rear };
    advanceMetro(fleet, 5);
    expect(fleet.poses[1]).toEqual(before);
  }
});

test("a rebuilt circuit projects moving rames and keeps the next station appointment", () => {
  const fleet = createMetroFleet(circle(), 12);
  const pose = { ...fleet.poses[0]! };
  const next = circle(8.5);
  reconfigureMetroFleet(fleet, next);
  expect(fleet.elapsed).toBe(12);
  expect(fleet.distances[0]).toBeCloseTo(projectTrajectory(next, pose.x, pose.y, pose.z), 8);
  advanceMetro(fleet, 18);
  expect(fleet.distances[0]).toBeCloseTo(next.total / 3, 8);
  advanceMetro(fleet, 6);
  expect(fleet.distances[0]).toBeCloseTo(next.total / 3, 8);
});

test("the timetable remains stable across the elapsed-clock wrap", () => {
  const route = circle();
  const fleet = createMetroFleet(route, 899.9);
  for (let i = 0; i < 186; i++) {
    advanceMetro(fleet, 1 / 30);
  }
  expect(fleet.elapsed).toBeCloseTo(6.1, 7);
  expect(fleet.distances[0]).toBeCloseTo((route.total / 72) * 0.1, 7);
});

test("the exported timetable is the one the fleet actually runs", () => {
  const route = circle();
  const fleet = createMetroFleet(route);
  const step = 1 / 30;
  for (let i = 0; i < 30 * 200; i++) {
    advanceMetro(fleet, step);
    for (let train = 0; train < TRAINS; train++) {
      const s = metroSchedule(fleet.elapsed, train);
      if (s.dwelling) {
        expect(fleet.distances[train]).toBeCloseTo((s.station * route.total) / STATIONS, 6);
        expect(stationDwellStop(fleet.elapsed, s.station)).toBeGreaterThanOrEqual(0);
        expect(stationDwellRemaining(fleet.elapsed, s.station)).toBeCloseTo(s.untilDeparture, 9);
      }
    }
  }
});

test("a station is served every 45 s and idle in between", () => {
  const served: number[] = [];
  let last = -1;
  for (let i = 0; i <= 30 * 200; i++) {
    const t = i / 30;
    const stop = stationDwellStop(t, 0);
    if (stop >= 0 && stop !== last) {
      served.push(t);
      last = stop;
    }
    if (stop < 0) {
      expect(stationDwellRemaining(t, 0)).toBe(-1);
    }
  }
  expect(served.length).toBe(5);
  for (let i = 1; i < served.length; i++) {
    expect(served[i]! - served[i - 1]!).toBeCloseTo(45, 1);
  }
});
