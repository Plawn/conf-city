import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { Biome, PropKind } from "../domain/biome";
import { scatterProps } from "../layout/props";
import type { CityLayout, RoadClass } from "../layout/types";
import { propGeometry } from "./buildings/propGeometry";
import { CLASS_STYLE, PAVEMENT } from "./geo/roadStyle";

/**
 * How far from a road's centreline a prop has to stay: its own half-width plus
 * the pavement outside the kerb. The scatter takes this in rather than reading
 * `CLASS_STYLE` itself — `layout/` has no business knowing how wide a road is
 * drawn, and this is the only place that decides it.
 */
const CLEARANCE: Record<RoadClass, number> = {
  street: CLASS_STYLE.street.width / 2 + PAVEMENT,
  avenue: CLASS_STYLE.avenue.width / 2 + PAVEMENT,
  boulevard: CLASS_STYLE.boulevard.width / 2 + PAVEMENT,
};

/** Sunk very slightly, so a trunk meets the ground rather than hovering over its own shadow. */
const ROOT_Y = -0.02;

/**
 * The island's vegetation: one instanced draw call per kind of plant.
 *
 * Everything here is settled at layout time and never touched again — no
 * `useFrame`, no per-tick write. A city of 400 props costs two draw calls and
 * two matrix uploads, once.
 */
export function Vegetation({ layout, biome }: { layout: CityLayout; biome: Biome }) {
  const groups = useMemo(() => {
    const matrices = new Map<PropKind, THREE.Matrix4[]>();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    for (const p of scatterProps(layout, biome, CLEARANCE)) {
      q.setFromAxisAngle(up, p.yaw);
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(p.at[0], ROOT_Y, p.at[1]),
        q,
        // A touch of horizontal-only variation on top of the uniform scale, so
        // two props of the same size are still not the same shape.
        new THREE.Vector3(p.scale * (0.92 + (p.yaw % 0.2)), p.scale, p.scale),
      );
      const list = matrices.get(p.kind);
      if (list) {
        list.push(m);
      } else {
        matrices.set(p.kind, [m]);
      }
    }
    return [...matrices.entries()].map(([kind, list]) => ({
      kind,
      matrices: list,
      geometry: propGeometry(kind, biome),
    }));
  }, [layout, biome]);

  // The geometries are built here, so they are disposed here: a city that
  // changes biome or grows a district rebuilds them and the old ones must go.
  useEffect(() => {
    return () => {
      for (const g of groups) {
        g.geometry.dispose();
      }
    };
  }, [groups]);

  return (
    <>
      {groups.map((g) => (
        <PropInstances key={g.kind} geometry={g.geometry} matrices={g.matrices} />
      ))}
    </>
  );
}

function PropInstances({
  geometry,
  matrices,
}: {
  geometry: THREE.BufferGeometry;
  matrices: THREE.Matrix4[];
}) {
  const ref = useRef<THREE.InstancedMesh>(null);

  useEffect(() => {
    const mesh = ref.current;
    if (!mesh) {
      return;
    }
    for (let i = 0; i < matrices.length; i++) {
      mesh.setMatrixAt(i, matrices[i]!);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [matrices]);

  return (
    <instancedMesh ref={ref} args={[geometry, undefined, matrices.length]} castShadow>
      <meshStandardMaterial vertexColors roughness={0.92} metalness={0} />
    </instancedMesh>
  );
}
