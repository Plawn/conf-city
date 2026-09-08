import { Html } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { float, normalView, positionLocal, positionView, smoothstep, uniform } from "three/tsl";
import { MeshBasicNodeMaterial } from "three/webgpu";
import { type CityUsage, heatColor, usageTooltip, worstUsage } from "../../domain/metrics";
import { useReducedMotion } from "../../hooks/useReducedMotion";
import type { UtilitySlot } from "../../layout/types";
import { useQualityProfile } from "../../store/uiStore";
import { useHtmlPortal } from "../htmlPortal";
import { createBeaconGeometry } from "../lighting/beaconGeometry";
import { gpuRenderer, isWebGPU, renderParams } from "../lighting/renderer";
import { createLightSource, useLighting } from "../lighting/runtime";

/**
 * The island's beacon: one tower on the first slot of the utility district,
 * next to the machine's three gauges, whose light is the **worst**
 * of the machine's three percentages — CPU, memory, disk.
 *
 * It exists for the far end of the open space. A badge with three numbers is
 * unreadable past a couple of metres; a sweeping green light that turns amber
 * and then red, and spins faster as it does, is not. Nothing here is a new
 * measurement: `worstUsage` is the same `cityUsage()` the badges already show.
 *
 * Two states say "do not trust this as the machine's load":
 *  - no figure at all → the lamp is dark grey and does not turn;
 *  - `fromHost === false` → the beam blinks, because the number behind it is
 *    the sum of the visible services, a floor rather than the machine.
 */

const TOWER_HEIGHT = 4.6;
const BASE_RADIUS = 0.62;
const TOP_RADIUS = 0.4;
/** Where the lamp sits — the gallery, just under the roof. */
const LAMP_Y = TOWER_HEIGHT + 0.42;
const LAMP_RADIUS = 0.34;
const BEAM_LENGTH = 16;
const BEAM_RADIUS = 1.5;
/** Radians per second at idle and saturation. */
const SWEEP_SLOW = 0.32;
const SWEEP_FAST = 1.9;
/** Blink period of the "services only" beam, seconds. */
const BLINK_PERIOD = 1.1;
const DARK = "#6b7280";

/** Module singletons: the geometry of a lighthouse never depends on the metrics. */
const towerGeometry = new THREE.CylinderGeometry(TOP_RADIUS, BASE_RADIUS, TOWER_HEIGHT, 12);
towerGeometry.translate(0, TOWER_HEIGHT / 2, 0);
const galleryGeometry = new THREE.CylinderGeometry(TOP_RADIUS + 0.22, TOP_RADIUS + 0.22, 0.14, 12);
galleryGeometry.translate(0, TOWER_HEIGHT + 0.07, 0);
const roofGeometry = new THREE.ConeGeometry(TOP_RADIUS + 0.16, 0.5, 12);
roofGeometry.translate(0, LAMP_Y + LAMP_RADIUS + 0.25, 0);
const lampGeometry = new THREE.SphereGeometry(LAMP_RADIUS, 12, 8);
lampGeometry.translate(0, LAMP_Y, 0);
/** Apex on the lamp, opening away along +Z — the group's yaw does the sweeping. */
const beamGeometry = createBeaconGeometry(BEAM_RADIUS, BEAM_LENGTH);

export function Lighthouse({
  slot,
  scale,
  usage,
}: {
  slot: UtilitySlot;
  /** The district's, so a cramped island gets a smaller beacon, not one in the sea. */
  scale: number;
  usage: CityUsage;
}) {
  const portal = useHtmlPortal();
  const lighting = useLighting();
  const reducedMotion = useReducedMotion();
  const gpu = isWebGPU(gpuRenderer(useThree((s) => s.gl)));
  const volumeAllowed = useQualityProfile().volume;
  const id = useId();
  const source = useMemo(() => createLightSource(`${id}:beacon`, "beacon"), [id]);
  useEffect(() => {
    lighting.sources.set(source.id, source);
    return () => {
      lighting.sources.delete(source.id);
    };
  }, [source, lighting]);
  const beamResources = useMemo(() => {
    const material = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const strength = uniform(0);
    const edge = normalView.dot(positionView.normalize()).abs().pow(0.8);
    const axial = float(1).sub(smoothstep(0, BEAM_LENGTH, positionLocal.z));
    material.opacityNode = edge.mul(axial).mul(strength);
    return { material, strength };
  }, []);
  useEffect(() => () => beamResources.material.dispose(), [beamResources]);
  const beam = useRef<THREE.Group>(null);
  const fallbackBeam = useRef<THREE.Mesh>(null);

  const lampMaterial = useRef<THREE.MeshBasicMaterial>(null);
  const [hover, setHover] = useState(false);

  const worst = worstUsage(usage);
  const color = useMemo(() => (worst == null ? DARK : heatColor(worst)), [worst]);
  const lampColor = useMemo(
    () => new THREE.Color(color).multiplyScalar(worst == null ? 1 : 2.5),
    [color, worst],
  );
  // A beam pointing at the sea rather than back over the city: the slot already
  // knows which way the water is.
  const seaYaw = Math.atan2(slot.shoreward[0], slot.shoreward[1]);

  useFrame((_, delta) => {
    source.visible = worst != null;
    if (worst == null) {
      source.intensity = 0;
      beamResources.strength.value = 0;
      return;
    }
    const group = beam.current;
    if (group && !reducedMotion) {
      group.rotation.y += (SWEEP_SLOW + Math.min(worst, 1.2) * (SWEEP_FAST - SWEEP_SLOW)) * delta;
    }
    // The lamp breathes at the sweep's rate; the beam blinks only when the
    // figure behind it is the service sum rather than the machine.
    const t = reducedMotion ? 0 : performance.now() / 1000;
    if (lampMaterial.current) {
      lampMaterial.current.opacity = 0.75 + 0.25 * Math.sin(t * 3);
    }
    const blink =
      usage.fromHost || reducedMotion ? 1 : (Math.sin((t / BLINK_PERIOD) * Math.PI * 2) + 1) / 2;
    beamResources.material.color.set(color);
    beamResources.strength.value = (0.03 + lighting.night.value * 0.22) * (0.2 + 0.8 * blink);
    // The selected projector gets a real volume, with no transparent shell over it.
    const volumetric =
      gpu &&
      volumeAllowed &&
      renderParams.get("volume") !== "0" &&
      lighting.night.value > 0.01 &&
      lighting.shadowBeaconId === source.id;
    if (fallbackBeam.current) {
      fallbackBeam.current.visible = !volumetric;
    }
    if (group) {
      group.updateWorldMatrix(true, false);
      source.position.set(0, LAMP_Y, 0).applyMatrix4(group.matrixWorld);
      source.direction.set(0, 0, 1).transformDirection(group.matrixWorld);
      source.color.set(color);
      source.intensity = 150 * (0.2 + 0.8 * blink);
      source.range = BEAM_LENGTH * scale;
      source.angle = Math.atan(BEAM_RADIUS / BEAM_LENGTH);
    }
  });

  return (
    <group
      position={[slot.center[0], 0, slot.center[1]]}
      rotation={[0, slot.yaw, 0]}
      scale={scale}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHover(true);
      }}
      onPointerOut={() => setHover(false)}
    >
      <mesh geometry={towerGeometry} castShadow receiveShadow>
        <meshStandardMaterial color="#e7e9f2" roughness={0.8} />
      </mesh>
      <mesh geometry={galleryGeometry} castShadow>
        <meshStandardMaterial color="#3a4256" roughness={0.7} />
      </mesh>
      <mesh geometry={roofGeometry} castShadow>
        <meshStandardMaterial color="#3a4256" roughness={0.7} />
      </mesh>
      <mesh geometry={lampGeometry}>
        <meshBasicMaterial ref={lampMaterial} color={lampColor} transparent opacity={0.9} />
      </mesh>
      {worst != null && (
        <group ref={beam} rotation={[0, -slot.yaw + seaYaw, 0]}>
          <mesh
            ref={fallbackBeam}
            geometry={beamGeometry}
            position={[0, LAMP_Y, 0]}
            raycast={() => {}}
          >
            <primitive attach="material" object={beamResources.material} />
          </mesh>
        </group>
      )}
      {hover && (
        <Html
          position={[0, LAMP_Y + 1.2, 0]}
          center
          portal={portal}
          style={{ pointerEvents: "none" }}
        >
          <div className="whitespace-nowrap rounded border border-white/10 bg-black/70 px-2 py-1 text-[11px] text-surface-200">
            <div className="font-semibold" style={{ color }}>
              {worst == null ? "No machine data" : `Worst: ${Math.round(worst * 100)}%`}
            </div>
            {!usage.fromHost && <div className="text-amber-200">Services only · partial load</div>}
            <div className="text-surface-400">{usageTooltip(usage, "cpu")}</div>
            <div className="text-surface-400">{usageTooltip(usage, "mem")}</div>
            {usage.diskPct != null && (
              <div className="text-surface-400">{usageTooltip(usage, "disk")}</div>
            )}
          </div>
        </Html>
      )}
    </group>
  );
}
