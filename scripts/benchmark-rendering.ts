import { cpus, release, totalmem } from "node:os";
import { outputDir } from "./harness";
import { fixtureWorld } from "./lighting-fixture";

/** Repeatable, sequential measurements: never compete with another browser benchmark. */
const runs = Number(process.env.CITY_RUNS ?? 3);
if (!Number.isInteger(runs) || runs < 1) {
  throw new Error("CITY_RUNS must be a positive integer");
}
const output = await outputDir("out/benchmark-rendering");
await Bun.write(
  `${output}/machine.json`,
  JSON.stringify(
    {
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      memoryBytes: totalmem(),
      platform: process.platform,
      release: release(),
    },
    null,
    2,
  ),
);
await Bun.write(`${output}/world.json`, JSON.stringify(fixtureWorld, null, 2));
for (let run = 1; run <= runs; run++) {
  for (const scenario of ["lighting", "camera"]) {
    const child = Bun.spawn([process.execPath, `scripts/check-${scenario}.ts`], {
      env: {
        ...process.env,
        CITY_RENDER_MODE: process.env.CITY_RENDER_MODE ?? "office",
        CITY_ASSERT_BUDGET:
          process.env.CITY_ASSERT_BUDGET ?? (process.env.GPU_SOFTWARE === "1" ? "0" : "1"),
        CITY_OUTPUT: `${output}/run-${run}/${scenario}`,
      },
      stdout: "inherit",
      stderr: "inherit",
    });
    const status = await child.exited;
    if (status !== 0) {
      throw new Error(`${scenario}, run ${run}: benchmark failed (${status})`);
    }
  }
}
