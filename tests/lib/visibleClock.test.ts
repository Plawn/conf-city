import { expect, test } from "bun:test";
import { createVisibleClock } from "@/lib/visibleClock";

test("construction time remains real time at 1, 5, 30 and 60 fps", () => {
  for (const fps of [1, 5, 30, 60]) {
    const clock = createVisibleClock();
    let seconds = 0;
    for (let frame = 0; frame <= 20 * fps; frame++) {
      seconds += clock.tick((frame / fps) * 1000);
    }
    expect(seconds).toBeCloseTo(20);
  }
});
test("visibility changes and unobserved sleeping time do not advance construction", () => {
  const clock = createVisibleClock();
  clock.tick(0);
  expect(clock.tick(1000)).toBe(1);
  clock.pause();
  expect(clock.tick(100000)).toBe(0);
  expect(clock.tick(101000)).toBe(1);
  expect(clock.tick(200000)).toBe(0);
});
