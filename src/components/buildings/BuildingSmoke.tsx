import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { allotPuffs, plumeLevel } from "../../domain/metrics/props";
import type { NodeType } from "../../domain/types";
import { useReducedMotion } from "../../hooks/useReducedMotion";
import { useQualityProfile } from "../../store/uiStore";
import { NO_RAYCAST } from "../three/instancing";
import { puffGeometry } from "../utilities/districtGeometry";

/** Reference height every model of a type is fitted to (`NODE_STYLE` `fit`). */
export const ROOF_HEIGHT: Record<NodeType, number> = { app: 2.88, db: 0.7, cache: 0.7, queue: 0.7 };

/** One smoking roof: world position of its top and its target smoke, 0..1 (`serviceSmoke`). */
export interface Chimney {
  x: number;
  z: number;
  top: number;
  rate: number;
}

/** Same breeze as the power station's plume, so every column leans one way. */
const WIND = [0.89, -0.45] as const;
const GOLDEN = 0.618034;
const LIFE_S = 3.2;
const CLEAN = new THREE.Color("#b4b8be");
const SOOT = new THREE.Color("#3a3b40");

/**
 * CPU as smoke: every busy building puffs from its roof, one instanced draw per
 * city. The city's `chimneyPuffs` budget is shared by smoke (`allotPuffs`), so
 * a hot service carries a tall dark column and an idle one stays clear — the
 * height of the buildings no longer has to say it.
 */
export function BuildingSmoke({ chimneys }: { chimneys: readonly Chimney[] }) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const reducedMotion = useReducedMotion();
  const budget = useQualityProfile().chimneyPuffs;
  const slots = useMemo(
    () =>
      allotPuffs(
        chimneys.map((c) => c.rate),
        budget,
      ),
    [chimneys, budget],
  );
  const total = slots.reduce((a, b) => a + b, 0);
  const levels = useRef<Float32Array>(new Float32Array(0));
  const dummy = useMemo(() => new THREE.Object3D(), []);

  // Smoothed levels survive a telemetry tick; only a new building count resets them.
  if (levels.current.length !== chimneys.length) {
    levels.current = Float32Array.from(chimneys, (c) => c.rate);
  }

  // Colour per puff only when the allotment changes: grey wisps, sooty when hot.
  useLayoutEffect(() => {
    const m = mesh.current;
    if (!m) {
      return;
    }
    const colour = new THREE.Color();
    let i = 0;
    chimneys.forEach((c, k) => {
      colour.copy(CLEAN).lerp(SOOT, c.rate * 0.8);
      for (let j = 0; j < slots[k]!; j++, i++) {
        m.setColorAt(i, colour);
      }
    });
    if (m.instanceColor) {
      m.instanceColor.needsUpdate = true;
    }
  }, [chimneys, slots]);

  useFrame((_, delta) => {
    const m = mesh.current;
    if (!m) {
      return;
    }
    const t = reducedMotion ? 0 : performance.now() / 1000;
    const lv = levels.current;
    let i = 0;
    chimneys.forEach((c, k) => {
      const level = plumeLevel(lv[k]!, c.rate, delta);
      lv[k] = level;
      const n = slots[k]!;
      const rise = 1.8 + level * 4;
      for (let j = 0; j < n; j++, i++) {
        const p = (t / LIFE_S + j * GOLDEN + k * 0.37) % 1;
        const along = (0.6 + level * 1.6) * p ** 1.4;
        const wob = Math.sin(j * 2.3 + k + p * 5) * 0.25 * p;
        dummy.position.set(
          c.x + WIND[0] * along + wob,
          c.top + 0.1 + rise * (1 - (1 - p) ** 2),
          c.z + WIND[1] * along + wob * 0.5,
        );
        const tail = p > 0.75 ? 1 - ((p - 0.75) / 0.25) ** 2 : 1;
        const size = (0.5 + p * (1.2 + level * 2)) * tail * (p < 0.05 ? p / 0.05 : 1);
        dummy.scale.set(size, size * 0.8, size);
        dummy.rotation.set(j, p * 1.5, k);
        dummy.updateMatrix();
        m.setMatrixAt(i, dummy.matrix);
      }
    });
    m.count = total;
    m.instanceMatrix.needsUpdate = true;
  });

  if (total === 0) {
    return null;
  }
  return (
    <instancedMesh
      key={total}
      ref={mesh}
      args={[puffGeometry, undefined, total]}
      frustumCulled={false}
      raycast={NO_RAYCAST}
    >
      <meshStandardMaterial
        transparent
        depthWrite={false}
        opacity={0.55}
        roughness={1}
        flatShading
      />
    </instancedMesh>
  );
}
