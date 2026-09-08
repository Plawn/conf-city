import { useThree } from "@react-three/fiber";
import { useEffect } from "react";
import { createFrameClock } from "../lib/frameClock";
import { gpuRenderer, isWebGPU } from "./lighting/renderer";

/** Owns the entire R3F tick: skipped frames run neither simulation nor draw calls. */
export function RenderLoop({ fps }: { fps: number }) {
  const advance = useThree((s) => s.advance);
  const get = useThree((s) => s.get);
  useEffect(() => {
    const clock = createFrameClock(fps, get().clock.elapsedTime);
    let frame = 0;
    let inFlight = 0;
    let active = true;
    const renderer = gpuRenderer(get().gl);
    const queue = isWebGPU(renderer)
      ? (
          renderer.backend as unknown as {
            device: { queue: { onSubmittedWorkDone: () => Promise<void> } };
          }
        ).device.queue
      : null;
    const render = (now: number) => {
      if (!active) {
        return;
      }
      const time = inFlight < 2 ? clock.tick(now) : null;
      if (time != null) {
        advance(time);
        // Bound submitted GPU work on slow adapters; two frames preserve CPU/GPU overlap.
        if (queue) {
          inFlight++;
          queue
            .onSubmittedWorkDone()
            .catch(() => {})
            .finally(() => {
              inFlight--;
            });
        }
      }
      frame = requestAnimationFrame(render);
    };
    const visibility = () => {
      cancelAnimationFrame(frame);
      clock.pause();
      if (!document.hidden) {
        frame = requestAnimationFrame(render);
      }
    };
    visibility();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [fps, advance, get]);
  return null;
}
