import { useEffect, useId, useMemo, useRef } from "react";
import * as THREE from "three";
import {
  advanceConstruction,
  type Construction,
  type ConstructionObservation,
  type Infrastructure,
} from "../domain/mobility";
import { VEHICLE_TINTS } from "../domain/nodeStyle";
import type { CityMeta, CityMetrics, NodeTelemetry } from "../domain/types";
import type { WorldLayout } from "../layout/types";
import { createVisibleClock } from "../lib/visibleClock";
import { EMPTY_INFRA, useMobilityStore } from "../store/mobilityStore";
import { useLighting } from "./lighting/runtime";
import { createVehicleLights } from "./lighting/VehicleLights";
import { useMobilityParticipant } from "./mobility/MobilitySimulation";
import { congestionSignals } from "./traffic/congestion";
import { writeDemand } from "./traffic/demand";
import { trafficStats } from "./traffic/lifecycle";
import { reconfigureSim } from "./traffic/reconfigure";
import { advance, createSim, type Pool, type TrafficRoute } from "./traffic/sim";
import { useVehicleGeometry, VEHICLE_MODELS } from "./traffic/useVehicleGeometry";

export type { TrafficRoute } from "./traffic/sim";

/** Both GLBs are normalised to the same length — without this the truck looks like a car. */
const TRUCK_SCALE = 1.25;

const scratchPos = new THREE.Vector3();
const scratchQuat = new THREE.Quaternion();
const scratchScale = new THREE.Vector3();
const scratchMatrix = new THREE.Matrix4();
const scratchColor = new THREE.Color();

function makeMesh(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  capacity: number,
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false; // instances move every frame; the mesh bounds never follow
  mesh.castShadow = true;
  mesh.count = 0;
  return mesh;
}

/** Writes one instance matrix per live vehicle of the pool. */
function writeMatrices(pool: Pool, mesh: THREE.InstancedMesh, scale: number): void {
  if (pool.count === 0 && mesh.count === 0) {
    return;
  }
  for (let i = 0; i < pool.count; i++) {
    scratchScale.setScalar(scale * pool.opacity[i]!);
    scratchPos.set(pool.x[i]!, pool.y[i]!, pool.z[i]!);
    scratchQuat.set(pool.qx[i]!, pool.qy[i]!, pool.qz[i]!, pool.qw[i]!);
    scratchMatrix.compose(scratchPos, scratchQuat, scratchScale);
    mesh.setMatrixAt(i, scratchMatrix);
  }
  mesh.count = pool.count;
  mesh.instanceMatrix.needsUpdate = true;
}

/** Re-uploads every live car's tint — slots move on spawn and swap-remove. */
function writeColors(pool: Pool, mesh: THREE.InstancedMesh): void {
  for (let i = 0; i < pool.count; i++) {
    mesh.setColorAt(i, scratchColor.set(VEHICLE_TINTS[pool.tint[i]!]!));
  }
  if (mesh.instanceColor) {
    mesh.instanceColor.needsUpdate = true;
  }
}

/**
 * Instanced traffic along a set of routes: one InstancedMesh per model, one
 * useFrame for everything, no React state per vehicle. The simulation itself —
 * following, yielding, spawning — lives in `traffic/sim.ts`.
 *
 * Spawn rate follows the source node's throughput — or `ambientRate` for the
 * routes that have no source, the ring road's loops; vehicles are removed when
 * they reach the end of their route (pop in/out is deliberate), except on
 * loops, where each journey ends after one or two laps (at most two minutes).
 */
export function TrafficSystem({
  routes,
  layout,
  telemetry,
  ambientRate = 0,
  maxCars = 240,
  maxTrucks = 60,
  visibleCities,
  infra = EMPTY_INFRA,
  cityMetrics,
  cityMeta,
}: {
  routes: TrafficRoute[];
  layout?: WorldLayout;
  /** "cityId/nodeId" → telemetry, as published by the stream. */
  telemetry?: Map<string, NodeTelemetry>;
  /** Vehicles per second on each route without a source node (before `rateScale`). */
  ambientRate?: number;
  maxCars?: number;
  maxTrucks?: number;
  visibleCities?: Set<string>;
  infra?: Infrastructure;
  cityMetrics?: Map<string, CityMetrics>;
  cityMeta?: Map<string, CityMeta>;
}) {
  const lighting = useLighting();
  const prefix = useId();
  const vehicleLights = useMemo(
    () => ({
      cars: createVehicleLights(maxCars, 1, `${prefix}:car`, lighting),
      trucks: createVehicleLights(maxTrucks, TRUCK_SCALE, `${prefix}:truck`, lighting),
    }),
    [maxCars, maxTrucks, lighting, prefix],
  );
  useEffect(
    () => () => {
      vehicleLights.cars.dispose();
      vehicleLights.trucks.dispose();
    },
    [vehicleLights],
  );
  const lightsTime = useRef(0);
  const car = useVehicleGeometry(VEHICLE_MODELS.car);
  const truck = useVehicleGeometry(VEHICLE_MODELS.truck);

  const carMesh = useMemo(
    () => makeMesh(car.geometry, car.material, maxCars),
    [car.geometry, car.material, maxCars],
  );
  const truckMesh = useMemo(
    () => makeMesh(truck.geometry, truck.material, maxTrucks),
    [truck.geometry, truck.material, maxTrucks],
  );
  useEffect(() => () => carMesh.dispose(), [carMesh]);
  useEffect(() => () => truckMesh.dispose(), [truckMesh]);

  const simRef = useRef<{
    sim: ReturnType<typeof createSim>;
    routes: TrafficRoute[];
    carsDirty: boolean;
    reportTime: number;
  } | null>(null);
  if (!simRef.current) {
    simRef.current = {
      sim: createSim(routes, maxCars, maxTrucks),
      routes,
      carsDirty: false,
      reportTime: 0,
    };
  } else if (
    simRef.current.routes !== routes ||
    simRef.current.sim.cars.id.length !== maxCars ||
    simRef.current.sim.trucks.id.length !== maxTrucks
  ) {
    // Routes or the tier's vehicle budget changed: keep the vehicles that still fit.
    simRef.current.sim = reconfigureSim(
      simRef.current.sim,
      simRef.current.routes,
      routes,
      maxCars,
      maxTrucks,
    );
    simRef.current.routes = routes;
    writeColors(simRef.current.sim.cars, carMesh);
  }
  const policy = useRef({
    elapsed: new Map<string, ConstructionObservation>(),
    jobs: [] as Construction[],
    version: useMobilityStore.getState().resetVersion,
  });

  const observationClock = useMemo(() => createVisibleClock(), []);
  useEffect(() => {
    const pause = () => {
      observationClock.pause();
      if (simRef.current) {
        simRef.current.reportTime = 0;
      }
    };
    document.addEventListener("visibilitychange", pause);
    return () => document.removeEventListener("visibilitychange", pause);
  }, [observationClock]);

  useMobilityParticipant(
    (dt) => {
      const timing = simRef.current!;
      const s = timing.sim;
      timing.reportTime += observationClock.tick(performance.now());
      writeDemand(
        s,
        routes,
        telemetry,
        infra,
        visibleCities,
        Date.now(),
        cityMetrics,
        cityMeta,
        ambientRate,
      );
      const store = useMobilityStore.getState();
      if (policy.current.version !== store.resetVersion) {
        policy.current = { elapsed: new Map(), jobs: [], version: store.resetVersion };
      }

      timing.carsDirty = advance(s, dt).carsDirty || timing.carsDirty;
      if (timing.reportTime >= 1) {
        const stats = trafficStats(s);
        const loads = congestionSignals(s, routes, stats, layout);
        const { completed, observations } = advanceConstruction(
          policy.current.elapsed,
          policy.current.jobs,
          infra,
          loads,
          timing.reportTime,
        );
        timing.reportTime = 0;
        for (const job of completed) {
          store.commit(job);
        }
        store.report(
          stats,
          policy.current.jobs.map((job) => ({ ...job })),
          observations,
        );
      }
    },
    () => {
      const timing = simRef.current!;
      const s = timing.sim;
      const now = performance.now();
      const dt = lightsTime.current ? Math.min(0.1, (now - lightsTime.current) / 1000) : 0;
      lightsTime.current = now;
      vehicleLights.cars.update(s.cars, dt);
      vehicleLights.trucks.update(s.trucks, dt);
      writeMatrices(s.cars, carMesh, 1);
      writeMatrices(s.trucks, truckMesh, TRUCK_SCALE);
      if (timing.carsDirty) {
        writeColors(s.cars, carMesh);
        timing.carsDirty = false;
      }
    },
  );

  return (
    <>
      <primitive object={vehicleLights.cars.group} />
      <primitive object={vehicleLights.trucks.group} />
      <primitive object={carMesh} />
      <primitive object={truckMesh} />
    </>
  );
}
