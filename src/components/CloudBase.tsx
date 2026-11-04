import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { PositionedNode } from "../domain/types";
import { cloudPuffs } from "../layout/cloud";
import type { Vec2 } from "../layout/types";
import { GOLDEN_ANGLE } from "../lib/math";
import { polygonCap } from "./geo/polygon";
import { NO_RAYCAST } from "./three/instancing";

/** Lit by the sun it reads near white; kept under the bloom threshold like every palette. */
const CLOUD_COLOR = "#9ea4ac";
const DECK_COLOR = "#8a9098";

/** A cloud service's ground: a flat deck at y = 0 over a seeded cluster of puffs. One draw each. */
export function CloudBase({
  cityId,
  outline,
  center,
  nodes,
}: {
  cityId: string;
  outline: Vec2[];
  center: Vec2;
  /** Buildings the deck mounds keep away from. */
  nodes: PositionedNode[];
}) {
  const puffs = useMemo(
    () =>
      cloudPuffs(
        cityId,
        outline,
        center,
        nodes.map((n) => [n.position[0], n.position[2]] as Vec2),
      ),
    [cityId, outline, center, nodes],
  );
  // Clearance only drops mounds: the unobstructed count bounds every later one.
  const capacity = useMemo(
    () => Math.max(1, cloudPuffs(cityId, outline, center).length),
    [cityId, outline, center],
  );
  const mesh = useRef<THREE.InstancedMesh>(null);
  const deck = useMemo(() => polygonCap(outline, -0.01), [outline]);
  const puffGeo = useMemo(() => new THREE.IcosahedronGeometry(1, 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new capacity remounts the mesh, which must be filled again.
  useLayoutEffect(() => {
    const m = mesh.current;
    if (!m) {
      return;
    }
    const dummy = new THREE.Object3D();
    puffs.forEach((p, i) => {
      dummy.position.set(p.x, p.y, p.z);
      dummy.scale.set(p.r, p.r * 0.72, p.r);
      dummy.rotation.set(0, (i * GOLDEN_ANGLE) % (Math.PI * 2), 0);
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
    });
    m.count = puffs.length;
    m.instanceMatrix.needsUpdate = true;
    m.computeBoundingSphere();
  }, [puffs, capacity]);

  useLayoutEffect(() => () => deck?.dispose(), [deck]);
  useLayoutEffect(() => () => puffGeo.dispose(), [puffGeo]);

  return (
    <group name={`cloud-${cityId}`}>
      {deck && (
        <mesh geometry={deck} castShadow receiveShadow raycast={NO_RAYCAST}>
          <meshStandardMaterial color={DECK_COLOR} roughness={1} />
        </mesh>
      )}
      <instancedMesh
        key={capacity}
        ref={mesh}
        args={[puffGeo, undefined, capacity]}
        castShadow
        raycast={NO_RAYCAST}
      >
        <meshStandardMaterial color={CLOUD_COLOR} roughness={1} flatShading />
      </instancedMesh>
    </group>
  );
}
