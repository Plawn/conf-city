import { useProgress } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { type ReactNode, useEffect, useRef } from "react";
import type { Camera, Group, InstancedMesh, Object3D } from "three";
import { type ShotKey, shotAt } from "../../domain/director";
import { cityLift } from "../../domain/replayLift";
import { activeKey, presenceAt, type Timeline } from "../../domain/scenario";
import {
  CAPTURE_MODE,
  replayCommit,
  replayPresence,
  useReplayStore,
} from "../../store/replayStore";

declare global {
  interface Window {
    /** Scripted control of the replay (headless checks and export). */
    __CITY_REPLAY__?: {
      totalSec: number;
      seek: (t: number) => void;
      /** `?capture=1`: show video second `t` of a `fps` sequence, resolved once it is on screen. */
      frame: (t: number, fps: number) => Promise<void>;
    };
  }
}

interface Controls {
  enabled: boolean;
  target: { set: (x: number, y: number, z: number) => void };
  update: () => void;
}

/** Runs before the building queue (-20): advances the clock, publishes presence, flies the camera. */
export function ReplayDriver({ timeline, shots }: { timeline: Timeline; shots: ShotKey[] }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as Controls | null;
  const director = useReplayStore((s) => s.director);
  const advance = useThree((s) => s.advance);
  const scene = useThree((s) => s.scene);
  const gl = useThree((s) => s.gl) as unknown as Compiler;
  useEffect(() => {
    if (controls) {
      controls.enabled = !director;
    }
  }, [controls, director]);
  useEffect(() => {
    let last = Number.NaN;
    window.__CITY_REPLAY__ = {
      totalSec: timeline.totalSec,
      seek: (t: number) => {
        useReplayStore.getState().setPlaying(false);
        useReplayStore.getState().setT(t);
      },
      frame: async (t: number, fps: number) => {
        const step = 1 / fps;
        // `last` starts NaN: the negated test sends the first frame down this path too.
        if (!(Math.abs(t - step - last) <= step / 10)) {
          // First frame or a jump: settle the scene, then pre-roll so traffic is already flowing.
          last = t - PREROLL;
          await show(timeline, last);
          await settle(advance, scene, last);
          await gl.compileAsync(scene, camera);
          for (let p = last + step; p < t - step / 2; p += step) {
            if (await show(timeline, p)) {
              await gl.compileAsync(scene, camera);
            }
            advance(p);
            await paint();
          }
        }
        // Shaders compile in parallel: an object whose program is not ready is skipped.
        if (await show(timeline, t)) {
          await gl.compileAsync(scene, camera);
        }
        // Scene time is video time: the clock, so every animation and the traffic step, follows t.
        advance(t);
        last = t;
        await paint();
      },
    };
    return () => {
      delete window.__CITY_REPLAY__;
    };
  }, [timeline, advance, scene, gl, camera]);

  useFrame((_, delta) => {
    const store = useReplayStore.getState();
    let t = store.t;
    if (store.playing && !CAPTURE_MODE) {
      t = Math.min(timeline.totalSec, t + delta * store.speed);
      store.setT(t);
      if (t >= timeline.totalSec) {
        store.setPlaying(false);
      }
    }
    const presence = presenceAt(timeline, t);
    replayPresence.cities = presence.cities;
    replayPresence.nodes = presence.nodes;
    replayPresence.links = presence.links;
    replayPresence.blasts = presence.blasts;
    const key = activeKey(presence);
    if (key !== store.activeKey) {
      store.setActiveKey(key);
    }
    if (store.director) {
      const pose = shotAt(shots, t);
      if (pose) {
        camera.position.set(...pose.position);
        if (controls) {
          controls.target.set(...pose.lookAt);
          controls.update();
        } else {
          camera.lookAt(...pose.lookAt);
        }
      }
    }
  }, -30);
  return null;
}

/** Simulated seconds before the first captured frame. */
const PREROLL = 2;

interface Compiler {
  compileAsync: (scene: Object3D, camera: Camera) => Promise<unknown>;
}

/** Set `t` and wait until React has committed its active set and every asset has loaded; true if it changed. */
async function show(timeline: Timeline, t: number): Promise<boolean> {
  const store = useReplayStore.getState();
  store.setT(t);
  const key = activeKey(presenceAt(timeline, t));
  const changed = key !== store.activeKey;
  if (changed) {
    store.setActiveKey(key);
  }
  await until(() => replayCommit.key === key && !useProgress.getState().active);
  if (changed) {
    // Let passive effects (instance matrices) run before the next render.
    await paint();
  }
  return changed;
}

/** Re-render at a fixed time (delta 0) until the scene graph stops growing: suspended parts mount late. */
async function settle(advance: (t: number) => void, scene: Object3D, t: number) {
  let previous = -1;
  let stable = 0;
  await until(() => {
    advance(t);
    let size = 0;
    scene.traverse((o) => {
      size += 1 + ((o as InstancedMesh).isInstancedMesh ? (o as InstancedMesh).count : 0);
    });
    stable = size === previous ? stable + 1 : 0;
    previous = size;
    return stable >= 10;
  });
}

function paint() {
  return new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

async function until(ready: () => boolean, timeoutMs = 30_000) {
  const start = performance.now();
  while (!ready()) {
    if (performance.now() - start > timeoutMs) {
      throw new Error("Replay frame: scene never settled");
    }
    await paint();
  }
}

/** A city emerging from the sea, or a cloud service coming down from the sky, with its presence. */
export function RisingCity({
  cityId,
  cloud,
  children,
}: {
  cityId: string;
  cloud: boolean;
  children: ReactNode;
}) {
  const group = useRef<Group>(null);
  useFrame(() => {
    group.current!.position.y = cityLift(replayPresence.cities.get(cityId) ?? 0, cloud);
  }, -29);
  return <group ref={group}>{children}</group>;
}
