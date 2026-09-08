import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { METRO_SHARE } from "../../domain/mobility";
import type { NodeTelemetry } from "../../domain/types";
import { fnv1a } from "../../layout/random";
import type { CityLayout } from "../../layout/types";
import { buildRibbon } from "../geo/ribbon";
import { liveTelemetry } from "../traffic/demand";
import { MetroStation } from "./MetroStation";
import { useMobilityParticipant } from "./MobilitySimulation";
import {
  advanceMetro,
  createMetroFleet,
  METRO_HEIGHT as HEIGHT,
  reconfigureMetroFleet,
} from "./metro";
import { buildMetroTrack } from "./metroTrack";
import {
  advancePassengers,
  createPassengerPool,
  MIN_TARGET,
  type PassengerPool,
  retargetPassengers,
} from "./passengers";
import { buildStationAccesses } from "./station";

const matrix = new THREE.Object3D();

/** Fixed-size fleets: shared geometry, no component/state per passenger. */
export function MetroSystem({
  city,
  telemetry,
  passengerBudget,
}: {
  city: CityLayout;
  telemetry?: Map<string, NodeTelemetry>;
  passengerBudget: number;
}) {
  const trains = useRef<THREE.InstancedMesh>(null);
  const people = useRef<THREE.InstancedMesh>(null);
  const route = useMemo(() => buildMetroTrack(city.roads.ring, HEIGHT), [city.roads]);
  const deck = useMemo(
    () =>
      route
        ? buildRibbon(
            Array.from(route.px, (x, i): [number, number, number] => [
              x,
              route.py[i]! - 0.08,
              route.pz[i]!,
            ]),
            0.48,
          )
        : null,
    [route],
  );
  const accesses = useMemo(
    () => (route ? buildStationAccesses(route, city.center) : []),
    [route, city.center],
  );
  useEffect(() => () => deck?.dispose(), [deck]);
  const fleet = useRef<ReturnType<typeof createMetroFleet> | null>(null);
  const pool = useRef<PassengerPool | null>(null);
  // In an effect, not in the render body: a fleet carries the trains' positions,
  // and React may render a component twice without committing it.
  useEffect(() => {
    if (!route) {
      fleet.current = null;
    } else if (fleet.current) {
      reconfigureMetroFleet(fleet.current, route);
    } else {
      fleet.current = createMetroFleet(route);
    }
    if (pool.current) {
      retargetPassengers(pool.current, accesses);
    }
  }, [route, accesses]);
  useEffect(() => {
    pool.current = createPassengerPool(Math.max(1, passengerBudget), fnv1a(city.cityId));
  }, [passengerBudget, city.cityId]);
  // Telemetry is summed on its own second, not once per rendered frame.
  const demand = useRef(0);
  const sinceSum = useRef(Number.POSITIVE_INFINITY);
  useMobilityParticipant(
    (dt) => {
      if (!fleet.current) {
        return;
      }
      advanceMetro(fleet.current, dt);
      sinceSum.current += dt;
      if (sinceSum.current >= 1) {
        sinceSum.current = 0;
        let sum = 0;
        const now = Date.now();
        for (const node of city.nodes) {
          const value = telemetry?.get(`${city.cityId}/${node.id}`);
          if (liveTelemetry(value, now)) {
            sum += Math.max(0, value.metrics.netTxKbps ?? (value.metrics.rps ?? 0) * 20);
          }
        }
        demand.current = sum;
      }
      if (pool.current) {
        const target = Math.min(
          passengerBudget,
          Math.max(MIN_TARGET, Math.ceil(Math.sqrt(demand.current / 100) * METRO_SHARE * 3)),
        );
        advancePassengers(pool.current, dt, {
          accesses,
          elapsed: fleet.current.elapsed,
          target,
        });
      }
    },
    () => {
      if (!fleet.current || !trains.current || !people.current) {
        return;
      }
      for (let i = 0; i < fleet.current.poses.length; i++) {
        const pose = fleet.current.poses[i]!;
        matrix.position.set(pose.x, pose.y + 0.17, pose.z);
        matrix.quaternion.set(pose.qx, pose.qy, pose.qz, pose.qw);
        matrix.scale.set(1, 1, 1);
        matrix.updateMatrix();
        trains.current.setMatrixAt(i, matrix.matrix);
      }
      trains.current.instanceMatrix.needsUpdate = true;
      const walkers = pool.current;
      if (!walkers) {
        people.current.count = 0;
        return;
      }
      for (let i = 0; i < walkers.count; i++) {
        matrix.position.set(walkers.x[i]!, walkers.y[i]! + 0.16, walkers.z[i]!);
        matrix.rotation.set(0, walkers.yaw[i]!, 0);
        matrix.scale.setScalar(Math.max(0, walkers.scale[i]!));
        matrix.updateMatrix();
        people.current.setMatrixAt(i, matrix.matrix);
      }
      people.current.count = walkers.count;
      people.current.instanceMatrix.needsUpdate = true;
    },
  );
  if (!route || !deck) {
    return null;
  }
  return (
    <group name={`metro:${city.cityId}`}>
      <mesh geometry={deck}>
        <meshStandardMaterial
          color="#40546c"
          metalness={0.55}
          roughness={0.5}
          side={THREE.DoubleSide}
        />
      </mesh>
      {accesses.map((access) => (
        <MetroStation key={access.index} access={access} />
      ))}
      <instancedMesh ref={trains} args={[undefined, undefined, 4]} frustumCulled={false}>
        <boxGeometry args={[0.3, 0.28, 0.7]} />
        <meshStandardMaterial color="#afffe4" emissive="#217d72" emissiveIntensity={0.45} />
      </instancedMesh>
      <instancedMesh
        ref={people}
        args={[undefined, undefined, Math.max(1, passengerBudget)]}
        frustumCulled={false}
      >
        <capsuleGeometry args={[0.06, 0.18, 2, 6]} />
        <meshStandardMaterial color="#ffd9a0" emissive="#ff9a3c" emissiveIntensity={0.35} />
      </instancedMesh>
    </group>
  );
}
