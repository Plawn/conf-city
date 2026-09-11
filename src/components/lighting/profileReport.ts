/** GPU pass durations are exclusive; CPU submission scopes may be nested. */
export interface PipelinePassSample {
  uid: string;
  name: string;
  group: string;
  kind: "render" | "compute";
  cpuMs: number;
  gpuMs: number | null;
}

export interface PipelineFrameSample {
  time: number;
  cpuMs: number;
  passes: PipelinePassSample[];
}

export function passGroup(name: string, compute = false): string {
  if (compute) {
    return /cluster/i.test(name) ? "Light clustering" : "Other compute";
  }
  // VSM blur quads are named `VSMVertical` / `VSMHorizontal` by three, without "shadow".
  if (/shadow|vsm/i.test(name)) {
    return "Shadows";
  }
  if (/bloom/i.test(name)) {
    return "Bloom";
  }
  if (/GTAO|\bAO\b|denoise/i.test(name)) {
    return "Contact shading";
  }
  if (/volume|gaussian/i.test(name)) {
    return "Lighthouse volume";
  }
  if (/FXAA|Render Pipeline/i.test(name)) {
    return "Composition / antialiasing";
  }
  if (/City scene/i.test(name)) {
    return "Scene / materials / lighting";
  }
  return "Other rendering";
}

function p95(values: number[]) {
  values.sort((a, b) => a - b);
  return values[Math.max(0, Math.ceil(values.length * 0.95) - 1)] ?? 0;
}

export function summarizePipeline(frames: readonly PipelineFrameSample[]) {
  // Never treat a missing timestamp as zero or mix partially measured GPU frames.
  const complete = frames.filter(
    (frame) => frame.passes.length > 0 && frame.passes.every((pass) => pass.gpuMs !== null),
  );
  const groups = [...new Set(complete.flatMap((frame) => frame.passes.map((pass) => pass.group)))];
  const totals = complete.map((frame) => frame.passes.reduce((sum, pass) => sum + pass.gpuMs!, 0));
  const totalMs = totals.reduce((sum, ms) => sum + ms, 0);
  return {
    capturedFrames: frames.length,
    completeGpuFrames: complete.length,
    gpuMeanMs: complete.length ? totalMs / complete.length : null,
    gpuP95Ms: complete.length ? p95(totals) : null,
    groups: groups
      .map((group) => {
        // Include zeros when an intermittent pass (e.g. a shadow) did not run.
        const values = complete.map((frame) =>
          frame.passes.reduce((sum, pass) => sum + (pass.group === group ? pass.gpuMs! : 0), 0),
        );
        const sum = values.reduce((total, ms) => total + ms, 0);
        return {
          name: group,
          meanMs: sum / complete.length,
          p95Ms: p95(values),
          share: totalMs > 0 ? sum / totalMs : 0,
        };
      })
      .sort((a, b) => b.meanMs - a.meanMs),
  };
}

/**
 * A weighted GPU work profile, NOT a wall-clock timeline. Three exposes durations,
 * not absolute GPU start/end times. Grouping is semantic, not a GPU call stack.
 */
export function pipelineSpeedscope(frames: readonly PipelineFrameSample[]) {
  const names: { name: string }[] = [];
  const indexes = new Map<string, number>();
  const index = (name: string) => {
    let result = indexes.get(name);
    if (result === undefined) {
      result = names.length;
      names.push({ name });
      indexes.set(name, result);
    }
    return result;
  };
  const samples: number[][] = [];
  const weights: number[] = [];
  for (const frame of frames) {
    if (frame.passes.length === 0 || frame.passes.some((pass) => pass.gpuMs === null)) {
      continue;
    }
    for (const pass of frame.passes) {
      if (pass.gpuMs! > 0) {
        samples.push([index("3D GPU work"), index(pass.group), index(pass.name)]);
        weights.push(pass.gpuMs!);
      }
    }
  }
  return {
    $schema: "https://www.speedscope.app/file-format-schema.json",
    name: "Conf City — GPU pass costs (grouped durations, not a timeline)",
    shared: { frames: names },
    profiles: [
      {
        type: "sampled",
        name: "GPU passes — use Left Heavy for aggregate costs",
        unit: "milliseconds",
        startValue: 0,
        endValue: weights.reduce((sum, value) => sum + value, 0),
        samples,
        weights,
      },
    ],
    activeProfileIndex: 0,
    exporter: "conf-city",
  };
}
