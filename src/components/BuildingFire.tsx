import { useFrame } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { fnv1a, mulberry32 } from "../lib/random";
import { NO_RAYCAST } from "./three/instancing";

const FLAMES = 12;
const PUFFS = 9;
const FLAME_COLORS = ["#ff4714", "#ff861c", "#ffd260"];

/** Two instanced draws per affected building; no lights, shadows or per-frame allocations. */
export function BuildingFire({
  seed,
  roof,
  width,
  depth,
  intensity,
}: {
  seed: string;
  roof: [number, number, number];
  width: number;
  depth: number;
  intensity: number;
}) {
  const flames = useRef<THREE.InstancedMesh>(null);
  const smoke = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const [reducedMotion, setReducedMotion] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const particles = useMemo(() => {
    const rand = mulberry32(fnv1a(seed));
    return Array.from({ length: FLAMES + PUFFS }, () => ({
      x: (rand() - 0.5) * 0.85,
      z: (rand() - 0.5) * 0.85,
      phase: rand(),
      size: 0.65 + rand() * 0.55,
      speed: 0.7 + rand() * 0.5,
    }));
  }, [seed]);

  useLayoutEffect(() => {
    if (!flames.current || !smoke.current) {
      return;
    }
    flames.current.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    smoke.current.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < FLAMES; i++) {
      // HDR warm cores feed the scene's existing bloom pass.
      flames.current.setColorAt(
        i,
        new THREE.Color(FLAME_COLORS[i % FLAME_COLORS.length]!).multiplyScalar(1.6),
      );
    }
    if (flames.current.instanceColor) {
      flames.current.instanceColor.needsUpdate = true;
    }
  }, []);

  useFrame(({ clock }) => {
    if (!flames.current || !smoke.current) {
      return;
    }
    const time = reducedMotion ? 0 : clock.elapsedTime;
    const size = Math.max(0.4, Math.min(width, depth, 1.6));
    const strength = 0.5 + intensity * 0.7;
    for (let i = 0; i < FLAMES; i++) {
      const p = particles[i]!;
      const wave = 0.8 + 0.2 * Math.sin(time * 5 * p.speed + p.phase * Math.PI * 2);
      const height = size * p.size * wave * strength;
      const radius = size * 0.23 * p.size * strength;
      dummy.position.set(p.x * width, height * 0.75 - 0.08, p.z * depth);
      dummy.rotation.set(
        0.12 * Math.sin(time * 2 + p.phase * 6),
        p.phase * 6,
        0.15 * Math.sin(time * 3 + i),
      );
      dummy.scale.set(radius, height, radius);
      dummy.updateMatrix();
      flames.current.setMatrixAt(i, dummy.matrix);
    }
    flames.current.instanceMatrix.needsUpdate = true;

    for (let i = 0; i < PUFFS; i++) {
      const p = particles[FLAMES + i]!;
      const age = (time * 0.22 * p.speed + p.phase) % 1;
      // Grow, drift, then shrink to zero before recycling at the roof.
      const envelope = Math.sin(Math.PI * age);
      const radius = size * (0.25 + age * 0.65) * p.size * envelope * strength;
      dummy.position.set(
        p.x * width * 0.6 + age * age * size * 1.2,
        size * 0.7 + age * (2 + size * 2) * strength,
        p.z * depth * 0.6 + Math.sin(age * 3 + p.phase * 6) * age * 0.3,
      );
      dummy.rotation.set(p.phase * 6 + age, age * 2, p.phase * 4);
      dummy.scale.set(radius, radius * 0.85, radius);
      dummy.updateMatrix();
      smoke.current.setMatrixAt(i, dummy.matrix);
    }
    smoke.current.instanceMatrix.needsUpdate = true;
  });

  return (
    <group position={roof} name="building-fire">
      <instancedMesh
        ref={flames}
        args={[undefined, undefined, FLAMES]}
        frustumCulled={false}
        raycast={NO_RAYCAST}
      >
        <coneGeometry args={[1, 2, 6]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <instancedMesh
        ref={smoke}
        args={[undefined, undefined, PUFFS]}
        frustumCulled={false}
        raycast={NO_RAYCAST}
      >
        <icosahedronGeometry args={[1, 1]} />
        <meshBasicMaterial color="#77717a" transparent opacity={0.42} depthWrite={false} />
      </instancedMesh>
    </group>
  );
}
