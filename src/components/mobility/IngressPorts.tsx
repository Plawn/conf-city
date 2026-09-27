import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { TERRAIN } from "../../domain/nodeStyle";
import type { NodeTelemetry } from "../../domain/types";
import type { Vec2, WorldLayout } from "../../layout/types";
import { liveTelemetry } from "../../sim/traffic/demand";
import { useHtmlPortal } from "../htmlPortal";
import { useShipGeometry } from "../traffic/useShipGeometry";

const MAX_BOATS = 24;
/** Ships calling at one berth at a time; past this the RX credit is simply dropped. */
const BOATS_PER_BERTH = 3;
const matrix = new THREE.Object3D();

/** One berth of one island, as the fleet needs it: where to come from, where to moor. */
interface Target {
  address: string;
  dock: Vec2;
  outside: Vec2;
  label: Vec2;
}

interface Voyage {
  address: string;
  progress: number;
}

/**
 * The fleet calling at the islands' ports.
 *
 * The quay itself is no longer drawn here: an ingress service *is* the port
 * (`layout/harbour.ts` puts it on the shoreline, `NodeMesh` draws it as the
 * quay), so this component owns only what floats — the ships, their wakes, and
 * the little "arrivals" tag over the berth.
 *
 * A ship is born from its own service's RX and steers to *that* service's berth:
 * on an island with several ingress services sharing one quay, the traffic is
 * legible per service rather than pooled into one dock.
 */
export function IngressPorts({
  layout,
  telemetry,
  visibleCities,
}: {
  layout: WorldLayout;
  telemetry?: Map<string, NodeTelemetry>;
  visibleCities: Set<string>;
}) {
  const portal = useHtmlPortal();
  const { geometry, material } = useShipGeometry();
  const hull = useRef<THREE.InstancedMesh>(null);
  const wake = useRef<THREE.InstancedMesh>(null);
  const fleet = useRef<Voyage[]>([]);
  const credits = useRef(new Map<string, number>());

  const targets = useMemo(
    () =>
      [...layout.cities.values()]
        .filter((c) => visibleCities.has(c.cityId) && c.harbour?.outside)
        .flatMap((city) =>
          city.harbour!.berths.map(
            (berth): Target => ({
              address: berth.address,
              dock: berth.dock,
              outside: city.harbour!.outside!,
              label: berth.position,
            }),
          ),
        ),
    [layout, visibleCities],
  );
  const byAddress = useMemo(() => new Map(targets.map((t) => [t.address, t])), [targets]);

  useFrame((_, dt) => {
    if (!hull.current || !wake.current) {
      return;
    }
    const now = Date.now();
    for (const key of credits.current.keys()) {
      if (!byAddress.has(key)) {
        credits.current.delete(key);
      }
    }
    for (const target of targets) {
      const value = telemetry?.get(target.address);
      const rx = liveTelemetry(value, now) ? Math.max(0, value.metrics.netRxKbps ?? 0) : 0;
      let credit =
        rx > 0
          ? (credits.current.get(target.address) ?? 0) +
            Math.min(0.12, Math.log2(1 + rx / 100) * 0.018) * dt
          : 0;
      if (credit >= 1) {
        if (
          fleet.current.length < MAX_BOATS &&
          fleet.current.filter((b) => b.address === target.address).length < BOATS_PER_BERTH
        ) {
          fleet.current.push({ address: target.address, progress: 0 });
        }
        credit %= 1;
      }
      credits.current.set(target.address, credit);
    }

    let count = 0;
    fleet.current = fleet.current.filter((boat) => {
      const target = byAddress.get(boat.address);
      if (!target) {
        return false;
      }
      // Each boat reaches its berth in one minute, then unloads and leaves the scene.
      boat.progress += dt / 60;
      if (boat.progress >= 1.05) {
        return false;
      }
      const u = Math.min(1, boat.progress);
      const dx = target.dock[0] - target.outside[0];
      const dz = target.dock[1] - target.outside[1];
      const scale = Math.min(1, boat.progress * 12, (1.05 - boat.progress) * 20);
      matrix.position.set(
        target.outside[0] + dx * u,
        TERRAIN.waterY + 0.05,
        target.outside[1] + dz * u,
      );
      // The hull's bow points at +Z, like every vehicle model in the world.
      matrix.rotation.set(0, Math.atan2(dx, dz), 0);
      matrix.scale.setScalar(scale);
      matrix.updateMatrix();
      hull.current!.setMatrixAt(count, matrix.matrix);

      const length = Math.hypot(dx, dz) || 1;
      matrix.position.set(
        matrix.position.x - (dx / length) * 2.2,
        TERRAIN.waterY + 0.025,
        matrix.position.z - (dz / length) * 2.2,
      );
      matrix.rotation.x = -Math.PI / 2;
      matrix.scale.set(scale * 1.6, scale * 3.4, scale);
      matrix.updateMatrix();
      wake.current!.setMatrixAt(count, matrix.matrix);
      count++;
      return true;
    });
    for (const mesh of [hull.current, wake.current]) {
      mesh.count = count;
      if (count) {
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
  });

  return (
    <group name="internet-ingress">
      {targets.map((t) => (
        <Html
          key={t.address}
          position={[t.label[0], 3.4, t.label[1]]}
          center
          portal={portal}
          style={{ pointerEvents: "none" }}
        >
          <span className="whitespace-nowrap rounded bg-slate-950/85 px-2 py-0.5 text-[10px] text-cyan-200">
            ⚓ Internet · ingress RX
          </span>
        </Html>
      ))}
      <instancedMesh
        name="ingress-ships"
        ref={hull}
        args={[geometry, material, MAX_BOATS]}
        frustumCulled={false}
        castShadow
      />
      <instancedMesh
        name="ingress-wakes"
        ref={wake}
        args={[undefined, undefined, MAX_BOATS]}
        frustumCulled={false}
      >
        <planeGeometry args={[0.8, 1.4]} />
        <meshBasicMaterial color="#99dedf" transparent opacity={0.14} depthWrite={false} />
      </instancedMesh>
    </group>
  );
}
