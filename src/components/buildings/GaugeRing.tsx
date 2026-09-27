import { useRef } from "react";
import * as THREE from "three";
import { heatColor } from "../../domain/metrics/format";
import { clamp01 } from "../../lib/math";
import { useBuildingAnimation } from "./BuildingAnimations";
import { color, DAMP, SETTLED } from "./visuals";

/** Quantisation of the gauge arc: one geometry per step, shared by the whole world. */
const GAUGE_STEPS = 24;

/**
 * Gauge geometry, shared across every building that asks for the same shape.
 *
 * There are only a handful of radii (one per node type) and 25 fill steps, so a
 * whole city draws from at most a few dozen distinct rings. Building them per
 * node meant a fresh geometry — and a fresh GPU upload — for every service on
 * every metrics tick that moved its needle by one step.
 */
const RING_CACHE = new Map<string, THREE.RingGeometry>();
function ringGeometry(radius: number, steps: number | null): THREE.RingGeometry {
  const key = `${radius}|${steps ?? "full"}`;
  let geo = RING_CACHE.get(key);
  if (!geo) {
    geo =
      steps == null
        ? new THREE.RingGeometry(radius, radius + 0.14, 48)
        : new THREE.RingGeometry(
            radius,
            radius + 0.14,
            48,
            1,
            0,
            (steps / GAUGE_STEPS) * Math.PI * 2,
          );
    RING_CACHE.set(key, geo);
  }
  return geo;
}

/**
 * Ground gauge: an arc whose length and colour follow a 0..1 saturation
 * (memory vs limit in health mode, the heatmap metric otherwise).
 */
export function GaugeRing({ radius, value }: { radius: number; value: number }) {
  const matRef = useRef<THREE.MeshBasicMaterial>(null);
  const clamped = clamp01(value);
  const steps = Math.max(1, Math.round(clamped * GAUGE_STEPS));
  const target = color(heatColor(clamped));
  const targetRef = useRef(target);
  targetRef.current = target;

  useBuildingAnimation(
    (_, delta) => {
      const m = matRef.current;
      if (!m) {
        return false;
      }
      const t = targetRef.current;
      // Same deal as the buildings: once the colour has arrived, stop touching it.
      if (
        Math.abs(m.color.r - t.r) < SETTLED &&
        Math.abs(m.color.g - t.g) < SETTLED &&
        Math.abs(m.color.b - t.b) < SETTLED
      ) {
        return false;
      }
      m.color.lerp(t, 1 - Math.exp(-DAMP * delta));
      return true;
    },
    [target],
  );

  // Above the neighbourhood slab (y 0.015, renderOrder 1): higher y, later renderOrder,
  // stronger polygon offset and no depth write → no z-fighting with it.
  return (
    <group rotation-x={-Math.PI / 2} position-y={0.06}>
      <mesh renderOrder={2} geometry={ringGeometry(radius, null)} dispose={null}>
        <meshBasicMaterial
          color="#000000"
          transparent
          opacity={0.35}
          side={THREE.DoubleSide}
          depthWrite={false}
          polygonOffset
          polygonOffsetFactor={-4}
          polygonOffsetUnits={-4}
        />
      </mesh>
      <mesh
        rotation-z={Math.PI / 2}
        renderOrder={3}
        geometry={ringGeometry(radius, steps)}
        dispose={null}
      >
        <meshBasicMaterial
          ref={matRef}
          color={heatColor(clamped)}
          toneMapped={false}
          transparent
          opacity={0.95}
          side={THREE.DoubleSide}
          depthWrite={false}
          polygonOffset
          polygonOffsetFactor={-5}
          polygonOffsetUnits={-5}
        />
      </mesh>
    </group>
  );
}
