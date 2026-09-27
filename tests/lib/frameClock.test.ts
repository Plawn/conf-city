import { describe, expect, test } from "bun:test";
import { createFrameClock } from "@/lib/frameClock";

describe("office render clock", () => {
  test.each([60, 120, 144])(
    "caps a %i Hz display to 30 updates/s without slowing animation",
    (refreshRate) => {
      const clock = createFrameClock(30);
      let frames = 0;
      let last = 0;
      for (let i = 0; i <= refreshRate * 10; i++) {
        const t = clock.tick((i * 1000) / refreshRate);
        if (t != null) {
          frames++;
          last = t;
        }
      }
      expect(frames).toBe(301);
      expect(last).toBeCloseTo(10, 6);
    },
  );

  test("smooth mode advances at 60 fps", () => {
    const clock = createFrameClock(60);
    let frames = 0;
    for (let i = 0; i <= 1200; i++) {
      if (clock.tick((i * 1000) / 120) != null) {
        frames++;
      }
    }
    expect(frames).toBe(601);
  });

  test("a hidden tab resumes without replaying hours of simulation", () => {
    const clock = createFrameClock(30, 50);
    expect(clock.tick(0)).toBe(50);
    const before = clock.tick(1000 / 30)!;
    clock.pause();
    expect(clock.tick(86_400_000)).toBe(before);
    expect(clock.tick(86_400_000 + 1000 / 30)).toBeCloseTo(before + 1 / 30);
  });

  test("slow frames bound catch-up work", () => {
    const clock = createFrameClock(30);
    clock.tick(0);
    expect(clock.tick(5000)).toBe(0.1);
    expect(clock.tick(5001)).toBeNull();
  });
});
