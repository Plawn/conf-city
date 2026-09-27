import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { type CityUsage, usageTooltip } from "../../domain/metrics/cityUsage";
import { heatColor } from "../../domain/metrics/format";
import { containerCount, smokeRate, tankLevel } from "../../domain/metrics/props";
import type { UtilityPlot, UtilitySlot } from "../../layout/types";
import { SceneLabel } from "../SceneLabel";
import {
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
 * one instanced mesh for the smoke and one for the boxes. Geometry is built
 * once at module load and never rebuilt — the metrics only ever move a
 * transform, a colour or an instance count.
 */

/** Puffs at full load. Fewer than this at 20 % must still read as "running". */
const MAX_PUFFS = 10;
const PUFF_RISE = 2.6;
/** Rises per second, idle → saturated. */
const PUFF_SLOW = 0.16;
const PUFF_FAST = 0.55;

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
            3.4 * plot.scale,
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

/** CPU: the stack smokes harder, faster and hotter as the machine works. */
function Plant({ cpuPct }: { cpuPct: number | undefined }) {
  const puffs = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const rate = smokeRate(cpuPct);

  useFrame(() => {
    const mesh = puffs.current;
    if (!mesh || rate == null) {
      return;
    }
    const visible = Math.max(1, Math.round(rate * MAX_PUFFS));
    mesh.count = visible;
    const speed = PUFF_SLOW + rate * (PUFF_FAST - PUFF_SLOW);
    const t = (performance.now() / 1000) * speed;
    for (let i = 0; i < visible; i++) {
      // Each puff walks the same climb, offset so the column is continuous.
      const p = (t + i / visible) % 1;
      const drift = Math.sin((p + i) * 3.1) * 0.28;
      dummy.position.set(PLANT.chimneyX + drift * p, PLANT.chimneyTop + p * PUFF_RISE, drift * p);
      // Grows as it climbs, then thins out — a puff never simply vanishes.
      dummy.scale.setScalar((0.45 + p * 1.5) * (1 - p * 0.55) * (0.6 + rate * 0.6));
      dummy.rotation.set(i, p * 2, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  if (rate == null) {
    return <UnderConstruction />;
  }
  return (
    <>
      <mesh geometry={plantGeometry} castShadow receiveShadow>
        <meshStandardMaterial vertexColors roughness={0.85} />
      </mesh>
      <instancedMesh ref={puffs} args={[puffGeometry, undefined, MAX_PUFFS]} frustumCulled={false}>
        <meshStandardMaterial
          color={heatColor(rate)}
          transparent
          opacity={0.42 + rate * 0.28}
          roughness={1}
          flatShading
        />
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
