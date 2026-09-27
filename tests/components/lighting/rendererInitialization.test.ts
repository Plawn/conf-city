import { expect, test } from "bun:test";
import { cachedInitializer } from "@/components/lighting/rendererInitialization";

test("concurrent canvas configuration shares one renderer and a new canvas gets its own", async () => {
  let creations = 0;
  const pending = Promise.withResolvers<object>();
  const initialize = cachedInitializer((_canvas: object) => {
    creations++;
    return pending.promise;
  });
  const canvas = {};
  const first = initialize(canvas);
  expect(initialize(canvas)).toBe(first);
  const renderer = {};
  pending.resolve(renderer);
  expect(await first).toBe(renderer);
  expect(initialize(canvas)).toBe(first);
  expect(creations).toBe(1);
  initialize({});
  expect(creations).toBe(2);
});

test("failed initialization can be retried without retaining a rejected renderer", async () => {
  let creations = 0;
  const initialize = cachedInitializer(async (_canvas: object) => {
    if (++creations === 1) {
      throw new Error("adapter unavailable");
    }
    return {};
  });
  const canvas = {};
  await expect(initialize(canvas)).rejects.toThrow("adapter unavailable");
  await initialize(canvas);
  expect(creations).toBe(2);
});
