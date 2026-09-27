import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { type CityUsage, usageTooltip } from "../../domain/metrics/cityUsage";
import { heatColor } from "../../domain/metrics/format";
import {
  containerCount,
  plumeLevel,
  smokeRate,
  smokeSurge,
  tankLevel,
} from "../../domain/metrics/props";
import { useReducedMotion } from "../../hooks/useReducedMotion";
import type { UtilityPlot, UtilitySlot } from "../../layout/types";
import { useQualityProfile } from "../../store/uiStore";
import { SceneLabel } from "../SceneLabel";
import {
  beaconLightGeometry,
  CONTAINER_SHADES,
  containerGeometry,
  OVERFLOW_SHADE,
  PLANT,
  plantGeometry,
  puffGeometry,
  QUAY,
  QUAY_CAPACITY,
  quayGeometry,
  scaffoldGeometry,
  TOWER,
  waterGeometry,
  waterTowerGeometry,
} from "./districtGeometry";

/**
 * The machine's three figures, built as a working waterfront next to the
 * lighthouse: a **power station** that smokes with the CPU, a **water tower**
 * that fills with the memory, and a **container quay** that stacks with the
 * disk.
 *
 * The point is a reading with no legend. Smoke, a water level and a pile of
 * boxes are things everyone already knows how to read, and all three are
 * visible from across a room, which a percentage is not.
 *
 * No figure is invented: everything comes from `cityUsage()`, the same source
 * as the badges. When a figure is not a machine measurement — no host mount, so
 * only the sum of the visible services — the installation is shown **under
 * construction** instead. A chimney at rest would otherwise read as an idle
 * machine, which is the one lie this district must never tell.
 *
 * Cost per island: four static draw calls (three shells and the water), plus
 * instanced meshes for the plume, the obstruction lights and the boxes. Geometry is built
 * once at module load and never rebuilt — the metrics only ever move a
 * transform, a colour or an instance count.
 */

/** Share of the puff budget the vent stack gets; the cooling towers split the rest. */
const VENT_SHARE = 0.2;
/** Seconds a steam puff lives at full load, and at rest: a heavy plume hangs longer. */
const STEAM_LIFE_FULL = 14;
const STEAM_LIFE_IDLE = 7;
const VENT_LIFE = 5;
/** How high steam rises before the wind lays it flat, and how far it then drifts. */
const STEAM_RISE = 4.2;
const STEAM_DRIFT = 16;
/** Wind in the slot frame (x along the shore, −z out to sea): the plume never lies over the city. */
const WIND = [0.89, -0.45] as const;
/** Plumes of a saturated machine climb this much higher. */
const SURGE_RISE = 3;
/** Golden-ratio phases: whatever prefix of the puffs is lit stays spread along the column. */
const GOLDEN = 0.618034;
const STEAM = new THREE.Color("#c3c8ce");
const SOOT = new THREE.Color("#3a3b40");
const VENT_SMOKE = new THREE.Color("#8c9096");
const BLINK_HZ = 1.4;

export function UtilityDistrict({ plot, usage }: { plot: UtilityPlot; usage: CityUsage }) {
  const [hover, setHover] = useState<"cpu" | "mem" | "disk" | null>(null);
  // Slot 0 is the lighthouse's; the three gauges take the rest of the waterfront.
  const [, plant, tower, quay] = plot.slots;
  if (!plant || !tower || !quay) {
    return null;
  }
  return (
    <>
      <Installation
        slot={plant}
        scale={plot.scale}
        onHover={() => setHover("cpu")}
        onOut={() => setHover(null)}
      >
        <Plant cpuPct={usage.fromHost ? usage.cpuPct : undefined} />
      </Installation>
      <Installation
        slot={tower}
        scale={plot.scale}
        onHover={() => setHover("mem")}
        onOut={() => setHover(null)}
      >
        <WaterTower memPct={usage.fromHost ? usage.memPct : undefined} />
      </Installation>
      <Installation
        slot={quay}
        scale={plot.scale}
        onHover={() => setHover("disk")}
        onOut={() => setHover(null)}
      >
        <Quay diskPct={usage.diskPct} />
      </Installation>
      {hover && (
        <SceneLabel
          position={[
            (hover === "cpu" ? plant : hover === "mem" ? tower : quay).center[0],
            (hover === "cpu" ? 6 : 3.4) * plot.scale,
            (hover === "cpu" ? plant : hover === "mem" ? tower : quay).center[1],
          ]}
        >
          <div className="whitespace-nowrap rounded border border-white/10 bg-black/70 px-2 py-1 text-[11px] text-surface-200">
            {usageTooltip(usage, hover)}
          </div>
        </SceneLabel>
      )}
    </>
  );
}

/** Puts one installation on its slot, facing the sea, sized to the land there. */
function Installation({
  slot,
  scale,
  onHover,
  onOut,
  children,
}: {
  slot: UtilitySlot;
  scale: number;
  onHover: () => void;
  onOut: () => void;
  children: React.ReactNode;
}) {
  return (
    <group
      position={[slot.center[0], 0, slot.center[1]]}
      rotation={[0, slot.yaw, 0]}
      scale={scale}
      onPointerOver={(e) => {
        e.stopPropagation();
        onHover();
      }}
      onPointerOut={onOut}
    >
      {children}
    </group>
  );
}

/** Nothing measured here: a building site, and no gauge to misread. */
function UnderConstruction() {
  return (
    <mesh geometry={scaffoldGeometry} castShadow receiveShadow>
      <meshStandardMaterial vertexColors roughness={0.85} />
    </mesh>
  );
}

/**
 * CPU: two cooling towers breathe steam and a vent stack smokes. The plume
 * follows a smoothed level — quick to build, a minute to die away — so a peak
 * is still hanging over the island after the load is gone. The steam rises,
 * then the wind lays it out along the shore as a long trail. Past 75 % the plume climbs
 * higher, the vent turns sooty and the towers' obstruction lights blink.
 */
function Plant({ cpuPct }: { cpuPct: number | undefined }) {
  const puffs = useRef<THREE.InstancedMesh>(null);
  const puffMaterial = useRef<THREE.MeshStandardMaterial>(null);
  const lights = useRef<THREE.InstancedMesh>(null);
  const lightMaterial = useRef<THREE.MeshBasicMaterial>(null);
  const reducedMotion = useReducedMotion();
  const budget = useQualityProfile().plumePuffs;
  const rate = smokeRate(cpuPct);
  const surgeTarget = smokeSurge(cpuPct);
  const state = useRef({ level: rate ?? 0, surge: surgeTarget ?? 0, shade: -1 });
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const colour = useMemo(() => new THREE.Color(), []);
  const vents = Math.max(1, Math.round(budget * VENT_SHARE));
  const perTower = Math.max(1, Math.floor((budget - vents) / PLANT.towers.length));
  const total = vents + perTower * PLANT.towers.length;

  useLayoutEffect(() => {
    const mesh = lights.current;
    if (!mesh) {
      return;
    }
    PLANT.towers.forEach((t, i) => {
      dummy.position.set(t.x, t.top + 0.05, 0);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    dummy.position.set(PLANT.vent.x, PLANT.vent.top + 0.05, PLANT.vent.z);
    dummy.updateMatrix();
    mesh.setMatrixAt(PLANT.towers.length, dummy.matrix);
    mesh.instanceMatrix.needsUpdate = true;
  }, [dummy]);

  useFrame((_, delta) => {
    const mesh = puffs.current;
    if (!mesh || rate == null || surgeTarget == null) {
      return;
    }
    const s = state.current;
    s.level = plumeLevel(s.level, rate, delta);
    s.surge = plumeLevel(s.surge, surgeTarget, delta);
    const { level, surge } = s;
    const t = reducedMotion ? 0 : performance.now() / 1000;

    // Steam: every puff keeps its phase; the level only fades the tail in and
    // out, so a changing load never reshuffles the column.
    const steamLife = STEAM_LIFE_IDLE + level * (STEAM_LIFE_FULL - STEAM_LIFE_IDLE);
    const rise = STEAM_RISE + surge * SURGE_RISE;
    let i = 0;
    PLANT.towers.forEach((tower, k) => {
      for (let j = 0; j < perTower; j++, i++) {
        const p = (t / steamLife + j * GOLDEN + k * 0.37) % 1;
        const fade = Math.min(1, Math.max(0, level * perTower * 1.15 - j));
        // Climbs fast out of the lip, then bends over and trails downwind.
        const up = rise * (1 - (1 - p) ** 3) + p * 0.5;
        const along = STEAM_DRIFT * (0.3 + level * 0.7) * p ** 1.3;
        const wob = Math.sin(j * 2.3 + p * 5) * 0.5 * p;
        dummy.position.set(
          tower.x + WIND[0] * along + wob,
          tower.top + 0.2 + up,
          WIND[1] * along + wob * 0.5,
        );
        // Born the width of the lip, swells downwind, shrinks away at the end of its life.
        const tail = p > 0.8 ? 1 - ((p - 0.8) / 0.2) ** 2 : 1;
        const size = (tower.lip * 1.4 + p * 2.6) * tail * (0.55 + level * 0.35 + surge * 0.25);
        dummy.scale.set(size, size * 0.75, size);
        dummy.rotation.set(j, p * 1.5, k);
        dummy.scale.multiplyScalar(fade * (p < 0.04 ? p / 0.04 : 1));
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }
    });
    // Vent: a thin, quicker column, sooty once the machine saturates.
    for (let j = 0; j < vents; j++, i++) {
      const p = (t / VENT_LIFE + j * GOLDEN) % 1;
      const fade = Math.min(1, Math.max(0, level * vents * 1.2 - j));
      const along = 3 * p * p;
      dummy.position.set(
        PLANT.vent.x + WIND[0] * along,
        PLANT.vent.top + p * (1.6 + surge * 1.4),
        PLANT.vent.z + WIND[1] * along,
      );
      dummy.scale.setScalar((0.5 + p * 1.6) * (0.6 + surge * 0.5) * fade);
      dummy.rotation.set(j, p * 2, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.count = total;
    mesh.instanceMatrix.needsUpdate = true;

    // Colours only when the plume visibly changes, not every frame.
    const shade = Math.round(level * 40) * 64 + Math.round(surge * 40);
    if (shade !== s.shade) {
      s.shade = shade;
      const vent = VENT_SMOKE.clone().lerp(SOOT, surge * 0.85);
      const steam = STEAM.clone().lerp(SOOT, surge * 0.25);
      for (let n = 0; n < total; n++) {
        mesh.setColorAt(n, n < total - vents ? steam : vent);
      }
      if (mesh.instanceColor) {
        mesh.instanceColor.needsUpdate = true;
      }
    }
    if (puffMaterial.current) {
      puffMaterial.current.opacity = 0.32 + level * 0.2 + surge * 0.25;
    }
    const light = lights.current;
    if (light && lightMaterial.current) {
      light.visible = surgeTarget > 0.05;
      const on = reducedMotion || Math.sin(t * BLINK_HZ * Math.PI * 2) > 0;
      lightMaterial.current.color.copy(colour.set("#ff2a1a")).multiplyScalar(on ? 3 : 0.25);
    }
  });

  if (rate == null) {
    return <UnderConstruction />;
  }
  return (
    <>
      <mesh geometry={plantGeometry} castShadow receiveShadow>
        <meshStandardMaterial vertexColors roughness={0.85} />
      </mesh>
      <instancedMesh
        key={total}
        ref={puffs}
        args={[puffGeometry, undefined, total]}
        frustumCulled={false}
      >
        <meshStandardMaterial
          ref={puffMaterial}
          transparent
          depthWrite={false}
          opacity={0.4}
          roughness={1}
          flatShading
        />
      </instancedMesh>
      <instancedMesh
        ref={lights}
        args={[beaconLightGeometry, undefined, PLANT.towers.length + 1]}
        visible={false}
      >
        <meshBasicMaterial ref={lightMaterial} toneMapped={false} />
      </instancedMesh>
    </>
  );
}

/** RAM: the tank fills. Empty at 0 %, brim-full and red at 100 %. */
function WaterTower({ memPct }: { memPct: number | undefined }) {
  const water = useRef<THREE.Mesh>(null);
  const level = tankLevel(memPct);

  useLayoutEffect(() => {
    const mesh = water.current;
    if (!mesh || level == null) {
      return;
    }
    // A transform, not a new geometry: the tank is never rebuilt.
    mesh.scale.set(1, Math.max(level * TOWER.tankHeight, 0.001), 1);
    mesh.position.y = TOWER.tankY - TOWER.tankHeight / 2;
  }, [level]);

  if (level == null) {
    return <UnderConstruction />;
  }
  return (
    <>
      <mesh geometry={waterTowerGeometry} castShadow receiveShadow>
        <meshStandardMaterial vertexColors roughness={0.8} />
      </mesh>
      <mesh ref={water} geometry={waterGeometry}>
        <meshStandardMaterial
          color={heatColor(level)}
          roughness={0.25}
          metalness={0.1}
          transparent
          opacity={0.9}
        />
      </mesh>
    </>
  );
}

/** DISK: boxes stack up on the quay, and spill over when it is nearly full. */
function Quay({ diskPct }: { diskPct: number | undefined }) {
  const boxes = useRef<THREE.InstancedMesh>(null);
  const load = containerCount(diskPct, QUAY_CAPACITY);

  useLayoutEffect(() => {
    const mesh = boxes.current;
    if (!mesh || !load) {
      return;
    }
    const dummy = new THREE.Object3D();
    const [bw, bh, bd] = QUAY.box;
    const shade = new THREE.Color();
    // Filled row by row from the ground up, so a growing disk grows a pile.
    for (let i = 0; i < load.count; i++) {
      const layer = Math.floor(i / QUAY.cols);
      const col = i % QUAY.cols;
      dummy.position.set(
        (col - (QUAY.cols - 1) / 2) * (bw + 0.1),
        QUAY.deckY + bh / 2 + layer * bh,
        0.15,
      );
      dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      // Linear, like the vertex colours of the industrial kit's own containers.
      mesh.setColorAt(
        i,
        shade.setRGB(...CONTAINER_SHADES[(col + layer) % CONTAINER_SHADES.length]!),
      );
    }
    if (load.overflow) {
      // One box too many, put down askew off the last row: a disk with nowhere left.
      dummy.position.set(-0.1, QUAY.deckY + bh / 2 + QUAY.layers * bh, 0.15 - bd * 0.35);
      dummy.rotation.set(0.12, 0.35, 0.16);
      dummy.updateMatrix();
      mesh.setMatrixAt(load.count, dummy.matrix);
      mesh.setColorAt(load.count, shade.setRGB(...OVERFLOW_SHADE));
    }
    mesh.count = load.count + (load.overflow ? 1 : 0);
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) {
      mesh.instanceColor.needsUpdate = true;
    }
  }, [load]);

  if (load == null) {
    return <UnderConstruction />;
  }
  return (
    <>
      <mesh geometry={quayGeometry} castShadow receiveShadow>
        <meshStandardMaterial vertexColors roughness={0.85} />
      </mesh>
      <instancedMesh
        ref={boxes}
        args={[containerGeometry, undefined, QUAY_CAPACITY + 1]}
        castShadow
        frustumCulled={false}
      >
        <meshStandardMaterial color="#ffffff" roughness={0.8} />
      </instancedMesh>
    </>
  );
}
