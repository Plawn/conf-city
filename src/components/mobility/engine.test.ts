import { expect, test } from "bun:test";
import { createMobilityEngine } from "./engine";

test("all transports share fixed steps and publish after simulation catch-up", () => {
  const engine = createMobilityEngine();
  const calls: string[] = [];
  for (const name of ["road", "rail"]) {
    engine.register({
      step: (dt) => {
        expect(dt).toBe(1 / 30);
        calls.push(name);
      },
      render: () => {
        calls.push(`${name}:render`);
      },
    });
  }
  engine.advance(1 / 60);
  expect(calls).toEqual([]);
  engine.advance(1 / 60);
  expect(calls).toEqual(["road", "rail", "road:render", "rail:render"]);
  calls.length = 0;
  engine.advance(100);
  expect(calls).toEqual([
    "road",
    "rail",
    "road",
    "rail",
    "road",
    "rail",
    "road:render",
    "rail:render",
  ]);
});

test("pause drops pending time and unregistered transports stop advancing", () => {
  const engine = createMobilityEngine();
  let steps = 0;
  const remove = engine.register({
    step: () => {
      steps++;
    },
    render: () => {},
  });
  engine.advance(1 / 60);
  engine.pause();
  engine.advance(1 / 60);
  expect(steps).toBe(0);
  engine.advance(1 / 60);
  expect(steps).toBe(1);
  remove();
  engine.advance(1);
  expect(steps).toBe(1);
});
