import { expect, test } from "bun:test";
import { ShadowRefreshPolicy } from "@/components/lighting/shadowRefresh";

const NOON = { x: 0, y: 1, z: 0 };

function input(overrides: Partial<Parameters<ShadowRefreshPolicy["decide"]>[0]> = {}) {
  return {
    time: 0,
    settingsChanged: false,
    sunDirection: NOON,
    sunIntensity: 1,
    worldTexel: 0.1,
    boundsMutated: false,
    buildingWrites: 0,
    viewMoved: false,
    ...overrides,
  };
}

test("first render happens for the sun, then a static world renders nothing", () => {
  const policy = new ShadowRefreshPolicy(6);
  expect(policy.decide(input())).toBe("sun");
  for (let i = 1; i < 60; i++) {
    expect(policy.decide(input({ time: i }))).toBeNull();
  }
});

test("reasons are explicit, ordered and throttled to the tier ceiling", () => {
  const policy = new ShadowRefreshPolicy(6);
  policy.decide(input());
  expect(policy.decide(input({ time: 0.05, buildingWrites: 3 }))).toBeNull();
  expect(policy.decide(input({ time: 0.1, viewMoved: true }))).toBeNull();
  expect(policy.decide(input({ time: 0.2 }))).toBe("view");
  expect(policy.decide(input({ time: 0.25 }))).toBeNull();
  expect(policy.decide(input({ time: 0.4, boundsMutated: true }))).toBe("bounds");
  expect(policy.decide(input({ time: 0.6, buildingWrites: 1 }))).toBe("buildings");
});

test("settings changes bypass the throttle and invalidate forces a render", () => {
  const policy = new ShadowRefreshPolicy(6);
  policy.decide(input());
  expect(policy.decide(input({ time: 0.01, settingsChanged: true }))).toBe("settings");
  expect(policy.decide(input({ time: 0.02 }))).toBeNull();
  policy.invalidate();
  expect(policy.decide(input({ time: 0.03 }))).toBe("settings");
});

test("sun motion counts in shadow texels: grazing sun refreshes, noon barely moves", () => {
  const policy = new ShadowRefreshPolicy(6);
  policy.decide(input());
  // 0.25° around noon moves a 12-unit pole tip by ~0.05: under a 0.1 texel.
  const nearNoon = { x: Math.sin(0.0044), y: Math.cos(0.0044), z: 0 };
  expect(policy.decide(input({ time: 1, sunDirection: nearNoon }))).toBeNull();
  const grazing = new ShadowRefreshPolicy(6);
  grazing.decide(input({ sunDirection: { x: Math.cos(0.2), y: Math.sin(0.2), z: 0 } }));
  const later = { x: Math.cos(0.2044), y: Math.sin(0.2044), z: 0 };
  expect(grazing.decide(input({ time: 1, sunDirection: later }))).toBe("sun");
});

test("a set sun renders nothing but keeps pending reasons for sunrise", () => {
  const policy = new ShadowRefreshPolicy(6);
  policy.decide(input());
  expect(policy.decide(input({ time: 1, sunIntensity: 0, buildingWrites: 5 }))).toBeNull();
  expect(policy.decide(input({ time: 2, sunIntensity: 0 }))).toBeNull();
  expect(policy.decide(input({ time: 3 }))).toBe("buildings");
});

test("setHz changes the ceiling without dropping pending work", () => {
  const policy = new ShadowRefreshPolicy(1);
  policy.decide(input());
  expect(policy.decide(input({ time: 0.5, viewMoved: true }))).toBeNull();
  policy.setHz(10);
  expect(policy.decide(input({ time: 0.6 }))).toBeNull();
  expect(policy.decide(input({ time: 1.0 }))).toBe("view");
  expect(policy.decide(input({ time: 1.05, viewMoved: true }))).toBeNull();
  expect(policy.decide(input({ time: 1.1 }))).toBe("view");
});
