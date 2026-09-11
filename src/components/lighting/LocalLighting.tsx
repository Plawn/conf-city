import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { Frustum, Group, Matrix4, PointLight, Sphere, SpotLight, Vector3 } from "three";
import { useQualityProfile } from "../../store/uiStore";
import { gpuRenderer, isWebGPU, renderParams } from "./renderer";
import {
  BEACON_VOLUME_LAYER,
  type LocalLightSource,
  SHADOW_CASTER_LAYER,
  useLighting,
} from "./runtime";
import { LightCandidates } from "./selection";

const BEACON_SHADOW_HZ = 15;

interface Slot {
  light: PointLight | SpotLight;
  id: string | null;
  fade: number;
}

function syncSlot(slot: Slot, source: LocalLightSource, night: number) {
  const light = slot.light;
  light.position.copy(source.position);
  light.color.copy(source.color);
  light.distance = source.range;
  light.intensity =
    source.intensity * slot.fade * (source.kind === "beacon" ? 0.15 + night * 0.85 : night);
  if (light instanceof SpotLight) {
    light.angle = source.angle;
    light.target.position.copy(source.position).add(source.direction);
    light.target.updateMatrixWorld();
  }
}

export function LocalLighting() {
  const runtime = useLighting();
  const renderer = gpuRenderer(useThree((s) => s.gl));
  const gpu = isWebGPU(renderer);
  const profile = useQualityProfile();
  const resources = useMemo(() => {
    const group = new Group();
    const points: Slot[] = [];
    const spots: Slot[] = [];
    // Allocate point lights lazily as streets register, avoiding 1024 empty lights in small worlds.
    // The tier caps the budget; `?lights=` only lowers it further for measurements.
    const requested = Number(renderParams.get("lights") ?? profile.pointLights);
    const pointLimit = gpu
      ? Math.max(
          1,
          Math.min(
            profile.pointLights,
            Number.isFinite(requested) ? requested : profile.pointLights,
          ),
        )
      : 8;
    for (let i = 0; i < (gpu ? profile.vehicleSpots : 8); i++) {
      const light = new SpotLight(0xffffff, 0, 6, 0.32, 0.7, 2);
      spots.push({ light, id: null, fade: 0 });
      group.add(light, light.target);
    }
    const beacon = runtime.beaconLight;
    beacon.shadow.camera.name = "Lighthouse shadow";
    beacon.layers.enable(BEACON_VOLUME_LAYER);
    // Casts for the component's lifetime; night only changes the intensity uniform and refresh.
    const shadowCapable = gpu && profile.beaconShadow && renderParams.get("shadows") !== "0";
    beacon.castShadow = shadowCapable;
    beacon.shadow.needsUpdate = shadowCapable;
    beacon.shadow.intensity = runtime.nightLights ? 1 : 0;
    beacon.shadow.mapSize.set(512, 512);
    // The sweep reads fine at 15 Hz; re-rendering the 512² map every frame does not.
    beacon.shadow.autoUpdate = false;
    beacon.shadow.camera.near = 0.15;
    // Non-default mask: keeps world casters during the layer-10 volume pass, excludes the volume.
    beacon.shadow.camera.layers.enable(SHADOW_CASTER_LAYER);
    // VSM: no depth compare, so no constant bias; `radius` is the blur in texels.
    beacon.shadow.bias = 0;
    beacon.shadow.normalBias = 0.03;
    beacon.shadow.radius = 2;
    beacon.shadow.blurSamples = 6;
    group.add(beacon, beacon.target);
    const beaconSlot: Slot = { light: beacon, id: null, fade: 0 };
    return {
      group,
      points,
      spots,
      beacon: beaconSlot,
      shadowCapable,
      pointLimit,
      selected: new Set<string>(),
      occupied: new Set<string>(),
      active: [] as Slot[],
      slots: [...spots, beaconSlot],
      candidates: {
        street: new LightCandidates(),
        vehicle: new LightCandidates(),
        beacon: new LightCandidates(),
        all: new LightCandidates(),
      },
      desiredByKind: { street: [] as string[], vehicle: [] as string[], beacon: [] as string[] },
      nextSelection: 0,
      nextBeaconShadow: 0,
      desired: new Set<string>(),
      frustum: new Frustum(),
      projection: new Matrix4(),
      sphere: new Sphere(),
      cameraPosition: new Vector3(),
    };
  }, [gpu, runtime, profile]);
  useEffect(
    () => () => {
      for (const slot of [...resources.points, ...resources.spots, resources.beacon]) {
        slot.light.dispose();
      }
      runtime.shadowBeaconId = null;
    },
    [resources, runtime],
  );
  useFrame(({ camera, clock }, delta) => {
    const r = resources;
    const night = runtime.night.value;
    // Vehicle spots exist at night only: one recompile per transition. The lighthouse map
    // is frozen by day and hidden through its intensity uniform, so `castShadow` never flips.
    r.beacon.light.shadow.intensity = runtime.nightLights ? 1 : 0;
    for (const slot of r.spots) {
      if (slot.light.visible !== runtime.nightLights) {
        slot.light.visible = runtime.nightLights;
      }
    }
    if (clock.elapsedTime >= r.nextSelection) {
      r.nextSelection = clock.elapsedTime + 0.2;
      camera.updateMatrixWorld();
      r.projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      r.frustum.setFromProjectionMatrix(r.projection, camera.coordinateSystem);
      camera.getWorldPosition(r.cameraPosition);
      for (const candidates of Object.values(r.candidates)) {
        candidates.clear();
      }
      let streets = 0;
      for (const source of runtime.sources.values()) {
        if (
          !source.visible ||
          source.intensity <= 0 ||
          (night < 0.001 && source.kind !== "beacon")
        ) {
          continue;
        }
        r.sphere.set(source.position, source.range);
        if (!r.frustum.intersectsSphere(r.sphere)) {
          continue;
        }
        const score =
          (source.intensity * source.range) /
          (1 + source.position.distanceToSquared(r.cameraPosition));
        r.candidates[gpu ? source.kind : "all"].add(source.id, score);
        if (source.kind === "street") {
          streets++;
        }
      }
      r.desired.clear();
      if (gpu) {
        r.candidates.street.select(r.selected, r.pointLimit, r.desired);
        r.candidates.vehicle.select(r.selected, r.spots.length, r.desired);
        r.candidates.beacon.select(r.selected, 1, r.desired);
      } else {
        r.candidates.all.select(r.selected, 8, r.desired);
      }
      for (const ids of Object.values(r.desiredByKind)) {
        ids.length = 0;
      }
      for (const id of r.desired) {
        r.desiredByKind[runtime.sources.get(id)!.kind].push(id);
      }
      r.selected.clear();
      for (const slot of r.slots) {
        if (slot.id) {
          r.selected.add(slot.id);
        }
      }
      const wantedPoints = Math.min(r.pointLimit, gpu ? streets : 8);
      while (r.points.length < wantedPoints) {
        const light = new PointLight(0xffd7a0, 0, 5, 2);
        const slot = { light, id: null, fade: 0 };
        r.slots.splice(r.points.length, 0, slot);
        r.points.push(slot);
        r.group.add(light);
      }
    }
    const occupied = r.occupied;
    occupied.clear();
    for (const slot of r.slots) {
      if (slot.id) {
        occupied.add(slot.id);
      }
    }
    const assign = (slot: Slot, kind: LocalLightSource["kind"]) => {
      const current = slot.id ? runtime.sources.get(slot.id) : undefined;
      const keep = !!current && current.visible && r.desired.has(current.id);
      slot.fade = Math.max(0, Math.min(1, slot.fade + Math.min(delta, 0.1) * (keep ? 4 : -6)));
      if (!current) {
        slot.fade = 0;
      }
      if (slot.fade === 0 && !keep) {
        if (slot.id) {
          occupied.delete(slot.id);
        }
        slot.id = null;
        for (const id of r.desiredByKind[kind]) {
          if (!occupied.has(id) && runtime.sources.has(id)) {
            slot.id = id;
            occupied.add(id);
            break;
          }
        }
      }
      const source = slot.id ? runtime.sources.get(slot.id) : undefined;
      if (source) {
        syncSlot(slot, source, night);
      } else {
        slot.light.intensity = 0;
      }
    };
    for (const slot of r.points) {
      assign(slot, "street");
    }
    for (const slot of r.spots) {
      assign(slot, "vehicle");
    }
    assign(r.beacon, "beacon");
    runtime.shadowBeaconId = r.beacon.id;
    if (
      r.beacon.light.castShadow &&
      runtime.nightLights &&
      clock.elapsedTime >= r.nextBeaconShadow
    ) {
      r.beacon.light.shadow.needsUpdate = true;
      runtime.frameWork.beaconShadowRenders++;
      r.nextBeaconShadow = clock.elapsedTime + 1 / BEACON_SHADOW_HZ;
    }
    // Fade-out can temporarily keep departing sources. Enforce the total fallback budget.
    if (!gpu) {
      const active = r.active;
      active.length = 0;
      for (const slot of r.slots) {
        if (slot.light.intensity > 0) {
          active.push(slot);
        }
      }
      active.sort((a, b) => b.fade - a.fade);
      for (let i = 8; i < active.length; i++) {
        active[i]!.light.intensity = 0;
      }
    }
  }, 0.5);
  return <primitive object={resources.group} />;
}
