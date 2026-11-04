import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { NodeTelemetry } from "../../domain/types";
import {
  type CableSpan,
  type Cableway,
  cablePoint,
  cableSpan,
  MAST_HEIGHT,
  TOP_STATION_HEIGHT,
  TOP_Y,
} from "../../layout/cableway";
import type { WorldLayout } from "../../layout/types";
import { sourceFlowKbps } from "../../sim/traffic/demand";
import { useQualityProfile } from "../../store/uiStore";
import { NO_RAYCAST } from "../three/instancing";

/** Half the gap between the up and down cables. */
const LATERAL = 0.4;
/** Cabin speed along the cable, world units per second. */
const SPEED = 1.6;
/** Cabins per direction: one cable never runs empty, and never turns into a conveyor belt. */
const MIN_PER_DIRECTION = 2;
const MAX_PER_DIRECTION = 6;
/** How far a cabin hangs under its cable. */
const HANG = 0.36;

const matrix = new THREE.Object3D();
const point: [number, number, number] = [0, 0, 0];

interface Line {
  way: Cableway;
  up: CableSpan;
  down: CableSpan;
  yaw: number;
}

function yawOf(way: Cableway) {
  return Math.atan2(way.top[0] - way.base[0], way.top[1] - way.base[1]);
}

function place(g: THREE.BufferGeometry, x: number, y: number, z: number, yaw: number) {
  return g.applyMatrix4(
    new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw),
      new THREE.Vector3(1, 1, 1),
    ),
  );
}

/** Masts in the sea and huts on the clouds, every cable car merged into one draw. */
function buildStations(lines: Line[]) {
  const parts: THREE.BufferGeometry[] = [];
  for (const { way, yaw } of lines) {
    const [bx, bz] = way.base;
    const [tx, tz] = way.top;
    parts.push(place(new THREE.CylinderGeometry(0.7, 0.85, 0.6, 8), bx, 0.05, bz, yaw));
    parts.push(
      place(
        new THREE.CylinderGeometry(0.12, 0.34, MAST_HEIGHT, 4),
        bx,
        MAST_HEIGHT / 2,
        bz,
        yaw + Math.PI / 4,
      ),
    );
    parts.push(place(new THREE.BoxGeometry(1.2, 0.16, 0.2), bx, MAST_HEIGHT, bz, yaw));
    parts.push(
      place(
        new THREE.BoxGeometry(1.3, TOP_STATION_HEIGHT, 1.1),
        tx,
        TOP_Y - TOP_STATION_HEIGHT / 2,
        tz,
        yaw,
      ),
    );
    parts.push(place(new THREE.BoxGeometry(1.5, 0.12, 1.3), tx, TOP_Y, tz, yaw));
  }
  const merged = mergeGeometries(parts.map((p) => p.toNonIndexed()));
  for (const p of parts) {
    p.dispose();
  }
  return merged;
}

function buildCables(lines: Line[]) {
  const parts = lines.flatMap(({ up, down }) =>
    [up, down].map((span) => {
      const points = Array.from(span.x, (x, i) => new THREE.Vector3(x, span.y[i]!, span.z[i]!));
      return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), points.length, 0.07, 5);
    }),
  );
  const merged = mergeGeometries(parts);
  for (const p of parts) {
    p.dispose();
  }
  return merged;
}

/** Cabins each line runs per direction, from its source services' traffic, within `budget` overall. */
function cabinCounts(
  lines: Line[],
  telemetry: Map<string, NodeTelemetry> | undefined,
  budget: number,
) {
  const now = Date.now();
  const wanted = lines.map(({ way }) => {
    let kbps = 0;
    for (const link of way.links) {
      kbps += sourceFlowKbps(telemetry?.get(`${link.fromCityId}/${link.fromNodeId}`), now);
    }
    return Math.min(MAX_PER_DIRECTION, Math.max(MIN_PER_DIRECTION, Math.ceil(Math.sqrt(kbps) / 8)));
  });
  const total = wanted.reduce((a, n) => a + 2 * n, 0);
  const scale = total > budget ? budget / total : 1;
  return wanted.map((n) => Math.floor(n * scale));
}

/**
 * Cable cars between the islands and the cloud services they call: a mast off
 * the shore, a hut on the cloud, two cables and cabins riding them both ways,
 * more of them as the source services send more.
 */
export function Cableways({
  layout,
  telemetry,
  visibleCities,
  cityPresence,
}: {
  layout: WorldLayout;
  telemetry?: Map<string, NodeTelemetry>;
  visibleCities: Set<string>;
  /** Replay: a line is strung once both of its ends have settled. */
  cityPresence?: (cityId: string) => number;
}) {
  const { maxCabins } = useQualityProfile();
  const candidates = useMemo(
    () =>
      layout.cableways.filter(
        (way) => visibleCities.has(way.ground) && visibleCities.has(way.cloud),
      ),
    [layout.cableways, visibleCities],
  );
  const isStrung = (w: Cableway) =>
    !cityPresence || (cityPresence(w.ground) >= 1 && cityPresence(w.cloud) >= 1);
  const strungKeys = () => new Set(candidates.filter(isStrung).map((w) => w.key));
  const [strung, setStrung] = useState(strungKeys);
  const lines = useMemo(
    () =>
      candidates
        .filter((way) => !cityPresence || strung.has(way.key))
        .map((way) => ({
          way,
          up: cableSpan(way, LATERAL),
          down: cableSpan(way, -LATERAL),
          yaw: yawOf(way),
        })),
    [candidates, strung, cityPresence],
  );
  // The replay reassembles an identical layout on every event: rebuild only when a line moves.
  const shapeKey = lines.map(({ way }) => `${way.key}:${way.base}:${way.top}`).join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the shape key covers everything the meshes read from `lines`.
  const shapes = useMemo(
    () =>
      lines.length > 0 ? { stations: buildStations(lines), cables: buildCables(lines) } : null,
    [shapeKey],
  );
  useEffect(
    () => () => {
      shapes?.stations.dispose();
      shapes?.cables.dispose();
    },
    [shapes],
  );

  const cabins = useRef<THREE.InstancedMesh>(null);
  const elapsed = useRef(0);
  const counts = useRef<number[]>([]);
  const sinceSum = useRef(Number.POSITIVE_INFINITY);
  useFrame((_, dt) => {
    if (cityPresence) {
      for (const way of candidates) {
        if (isStrung(way) !== strung.has(way.key)) {
          setStrung(strungKeys());
          break;
        }
      }
    }
    const mesh = cabins.current;
    if (!mesh) {
      return;
    }
    elapsed.current += dt;
    // Telemetry is summed once a second, not once per rendered frame.
    sinceSum.current += dt;
    if (sinceSum.current >= 1 || counts.current.length !== lines.length) {
      sinceSum.current = 0;
      counts.current = cabinCounts(lines, telemetry, maxCabins);
    }
    let k = 0;
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li]!;
      const n = counts.current[li] ?? 0;
      for (let d = 0; d < 2; d++) {
        const span = d === 0 ? line.up : line.down;
        const lap = (elapsed.current * SPEED) / span.length;
        for (let i = 0; i < n; i++) {
          const u = (lap + i / n) % 1;
          cablePoint(span, d === 0 ? u : 1 - u, point);
          matrix.position.set(point[0], point[1] - HANG, point[2]);
          matrix.rotation.set(0, line.yaw, 0);
          matrix.updateMatrix();
          mesh.setMatrixAt(k++, matrix.matrix);
        }
      }
    }
    mesh.count = k;
    mesh.instanceMatrix.needsUpdate = true;
  });

  if (!shapes) {
    return null;
  }
  return (
    <group name="cableways">
      <mesh geometry={shapes.stations} castShadow receiveShadow>
        <meshStandardMaterial color="#5a6470" metalness={0.4} roughness={0.6} flatShading />
      </mesh>
      <mesh geometry={shapes.cables} raycast={NO_RAYCAST}>
        <meshStandardMaterial color="#7a7f86" metalness={0.3} roughness={0.5} />
      </mesh>
      <instancedMesh
        ref={cabins}
        args={[undefined, undefined, Math.max(1, maxCabins)]}
        frustumCulled={false}
        castShadow
        raycast={NO_RAYCAST}
      >
        <boxGeometry args={[0.56, 0.5, 0.48]} />
        <meshStandardMaterial color="#7a3326" emissive="#3a1208" emissiveIntensity={0.4} />
      </instancedMesh>
    </group>
  );
}
