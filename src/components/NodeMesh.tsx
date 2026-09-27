import { Html, useGLTF } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { BuildingVariant } from "../domain/buildingVariant";
import { nodeIncident } from "../domain/incidents";
import {
  type CityMax,
  cpuSaturation,
  formatKbps,
  formatMb,
  heatColor,
  heatValue,
  memoryHeight,
  memSaturation,
  netKbps,
} from "../domain/metrics";
import { LIVENESS_COLORS, LIVENESS_TONE, NODE_STYLE, PORT_ASSETS } from "../domain/nodeStyle";
import type { NodeTelemetry, NodeType, PositionedNode } from "../domain/types";
import { clamp01 } from "../lib/math";
import { useUiStore } from "../store/uiStore";
import { BuildingFire } from "./BuildingFire";
import { useBuildingAnimation } from "./buildings/BuildingAnimations";
import { harbourGeometry } from "./buildings/harbourGeometry";
import { InstancedBuilding } from "./buildings/InstancedBuilding";
import {
  color,
  DAMP,
  heightTarget,
  MAP_TINT,
  MaterialAnimation,
  mapTinted,
  PORT_TINT,
  SETTLED,
  type VisualState,
} from "./buildings/visuals";
import { useHtmlPortal } from "./htmlPortal";
import { Badge } from "./ui";

export const NODE_CONFIG = NODE_STYLE;

// Preload every model a variant may pick
for (const config of Object.values(NODE_CONFIG)) {
  for (const m of config.models) {
    useGLTF.preload(m.path);
  }
}

function useMaterialVisuals(
  materials: THREE.MeshStandardMaterial[],
  fade: number,
  variant: BuildingVariant,
  visualRef: { current: VisualState },
) {
  const animation = useMemo(() => new MaterialAnimation(variant, fade), [variant, fade]);
  useBuildingAnimation(
    (time, delta, night) =>
      animation.advance(materials, visualRef.current, night, time, delta).active,
    [animation, materials, visualRef.current],
    true,
  );
}

/**
 * Footprint of the quay, in world units: the model is authored ~1.5 wide, and a
 * lattice cell is `PITCH` (6). Big enough to read as a port from the city's own
 * camera distance, small enough that two berths a couple of cells apart do not
 * overlap.
 */
const PORT_SCALE = 2.6;

/**
 * The port an ingress service *is*, in place of a building.
 *
 * Two things separate it from `NodeModel`: the yaw is **imposed** by the berth's
 * bearing (the quay has to face the sea; a seeded k·π/2 turn would put the
 * cranes over the fields), and the height is **frozen** — a quay does not grow
 * with the service's memory. Everything else — the tint, the CPU glow, the error
 * flash, the hover and selection highlight — is the same drive as every other
 * node, so a port reads at a glance like the service it is.
 */
function PortModel({
  bearing,
  variant,
  visual,
  isDiscovered,
}: {
  bearing: number;
  variant: BuildingVariant;
  visual: VisualState;
  isDiscovered?: boolean;
}) {
  const visualRef = useRef(visual);
  visualRef.current = visual;

  // `PORT_ASSETS.harbour` is null until the real GLB lands, and hooks cannot be
  // called conditionally — so drei is handed a model we know exists and its
  // scene is ignored, the quay coming from `harbourGeometry()` instead.
  const glb = PORT_ASSETS.harbour;
  const { scene } = useGLTF(glb ?? NODE_CONFIG.app.modelPath);

  // `glb` is a module constant (`PORT_ASSETS.harbour`), so it is not a dependency:
  // swapping it means a reload, and the two branches below are picked once.
  const { object, materials, geometry } = useMemo(() => {
    const materials: THREE.MeshStandardMaterial[] = [];
    const paint = (map: THREE.Texture | null, vertexColors: boolean) => {
      const mat = new THREE.MeshStandardMaterial({
        map,
        vertexColors,
        color: mapTinted(variant.color, PORT_TINT),
        emissive: variant.emissive,
        emissiveIntensity: 0.3,
        metalness: 0.1,
        roughness: 0.7,
        transparent: !!isDiscovered,
        opacity: isDiscovered ? 0.75 : 1,
      });
      materials.push(mat);
      return mat;
    };
    if (!glb) {
      const geometry = harbourGeometry();
      const mesh = new THREE.Mesh(geometry, paint(null, true));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      return { object: mesh, materials, geometry };
    }
    const clone = scene.clone(true);
    clone.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        const src = (Array.isArray(child.material) ? child.material[0] : child.material) as
          | THREE.MeshStandardMaterial
          | undefined;
        child.material = paint(src?.map ?? null, child.geometry.hasAttribute("color"));
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    return { object: clone, materials, geometry: null };
  }, [scene, variant, isDiscovered]);

  useEffect(() => {
    return () => {
      geometry?.dispose();
      for (const m of materials) {
        m.dispose();
      }
    };
  }, [geometry, materials]);

  useMaterialVisuals(materials, PORT_TINT, variant, visualRef);

  return <primitive object={object} scale={PORT_SCALE} rotation-y={bearing} />;
}

function NodeModel({
  addr,
  type,
  variant,
  visual,
  isDiscovered,
  fireIntensity,
}: {
  addr: string;
  type: NodeType;
  variant: BuildingVariant;
  visual: VisualState;
  isDiscovered?: boolean;
  fireIntensity: number;
}) {
  const config = NODE_CONFIG[type];
  const { scene } = useGLTF(variant.model);
  const visualRef = useRef(visual);
  visualRef.current = visual;
  const scaleGroup = useRef<THREE.Group>(null);
  const fireBounds = useMemo(() => {
    const bounds = new THREE.Box3().setFromObject(scene);
    const s = config.scale * variant.fit * variant.scale;
    return {
      roof: [
        ((bounds.min.x + bounds.max.x) * s) / 2,
        bounds.max.y * s,
        ((bounds.min.z + bounds.max.z) * s) / 2,
      ] as [number, number, number],
      width: (bounds.max.x - bounds.min.x) * s,
      depth: (bounds.max.z - bounds.min.z) * s,
    };
  }, [scene, config.scale, variant.fit, variant.scale]);

  // Clone the GLTF once; all per-frame visuals are driven imperatively below.
  // The material is rebuilt rather than reused (every visual below is written
  // imperatively, and `scene` is the shared cached GLTF), but the maps the loader
  // resolved are carried over — they are what the building's detail is made of.
  const { clonedScene, materials, textured } = useMemo(() => {
    const clone = scene.clone(true);
    const materials: THREE.MeshStandardMaterial[] = [];
    let textured = false;
    clone.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        const src = (Array.isArray(child.material) ? child.material[0] : child.material) as
          | THREE.MeshStandardMaterial
          | undefined;
        const map = src?.map ?? null;
        if (map) {
          textured = true;
        }
        const mat = new THREE.MeshStandardMaterial({
          map,
          normalMap: src?.normalMap ?? null,
          vertexColors: child.geometry.hasAttribute("color"),
          color: map ? mapTinted(variant.color) : variant.color,
          emissive: variant.emissive,
          emissiveIntensity: 0.3,
          // A building is masonry, glass and painted steel — not a mirror. The old
          // 0.3 metalness read as grey plastic under a fill-only light and turns
          // openly wrong now that there is an environment to reflect.
          metalness: 0.08,
          roughness: 0.72,
          transparent: !!isDiscovered,
          opacity: isDiscovered ? 0.75 : 1,
        });
        child.material = mat;
        child.castShadow = true;
        child.receiveShadow = true;
        materials.push(mat);
      }
    });
    return { clonedScene: clone, materials, textured };
  }, [scene, variant, isDiscovered]);

  useEffect(() => {
    return () => {
      for (const m of materials) {
        m.dispose();
      }
    };
  }, [materials]);

  useMaterialVisuals(materials, textured ? MAP_TINT : 0, variant, visualRef);

  const targetY = heightTarget(type, visual);
  useBuildingAnimation(
    (_, delta) => {
      const group = scaleGroup.current;
      if (!group || Math.abs(group.scale.y - targetY) <= 1e-3) {
        return false;
      }
      group.scale.y = THREE.MathUtils.damp(group.scale.y, targetY, 4, delta);
      return true;
    },
    [targetY],
  );

  // Height (memory) lives on the parent group; the variant's turn and size sit
  // on the model itself, under it, so the two never fight.
  return (
    <group ref={scaleGroup}>
      <primitive
        object={clonedScene}
        scale={config.scale * variant.fit * variant.scale}
        rotation-y={variant.yaw}
      />
      {fireIntensity > 0 && (
        <group rotation-y={variant.yaw}>
          <BuildingFire seed={addr} {...fireBounds} intensity={fireIntensity} />
        </group>
      )}
    </group>
  );
}

/** Quantisation of the gauge arc: one geometry per step, shared by the whole world. */
const GAUGE_STEPS = 24;

/**
 * Gauge geometry, shared across every building that asks for the same shape.
 *
 * There are only a handful of radii (one per node type) and 25 fill steps, so a
 * whole city draws from at most a few dozen distinct rings. Building them per
 * node meant a fresh geometry — and a fresh GPU upload — for every service on
 * every metrics tick that moved its needle by one step.
 */
const RING_CACHE = new Map<string, THREE.RingGeometry>();
function ringGeometry(radius: number, steps: number | null): THREE.RingGeometry {
  const key = `${radius}|${steps ?? "full"}`;
  let geo = RING_CACHE.get(key);
  if (!geo) {
    geo =
      steps == null
        ? new THREE.RingGeometry(radius, radius + 0.14, 48)
        : new THREE.RingGeometry(
            radius,
            radius + 0.14,
            48,
            1,
            0,
            (steps / GAUGE_STEPS) * Math.PI * 2,
          );
    RING_CACHE.set(key, geo);
  }
  return geo;
}

/**
 * Ground gauge: an arc whose length and colour follow a 0..1 saturation
 * (memory vs limit in health mode, the heatmap metric otherwise).
 */
function GaugeRing({ radius, value }: { radius: number; value: number }) {
  const matRef = useRef<THREE.MeshBasicMaterial>(null);
  const clamped = clamp01(value);
  const steps = Math.max(1, Math.round(clamped * GAUGE_STEPS));
  const target = color(heatColor(clamped));
  const targetRef = useRef(target);
  targetRef.current = target;

  useBuildingAnimation(
    (_, delta) => {
      const m = matRef.current;
      if (!m) {
        return false;
      }
      const t = targetRef.current;
      // Same deal as the buildings: once the colour has arrived, stop touching it.
      if (
        Math.abs(m.color.r - t.r) < SETTLED &&
        Math.abs(m.color.g - t.g) < SETTLED &&
        Math.abs(m.color.b - t.b) < SETTLED
      ) {
        return false;
      }
      m.color.lerp(t, 1 - Math.exp(-DAMP * delta));
      return true;
    },
    [target],
  );

  // Above the neighbourhood slab (y 0.015, renderOrder 1): higher y, later renderOrder,
  // stronger polygon offset and no depth write → no z-fighting with it.
  return (
    <group rotation-x={-Math.PI / 2} position-y={0.06}>
      <mesh renderOrder={2} geometry={ringGeometry(radius, null)} dispose={null}>
        <meshBasicMaterial
          color="#000000"
          transparent
          opacity={0.35}
          side={THREE.DoubleSide}
          depthWrite={false}
          polygonOffset
          polygonOffsetFactor={-4}
          polygonOffsetUnits={-4}
        />
      </mesh>
      <mesh
        rotation-z={Math.PI / 2}
        renderOrder={3}
        geometry={ringGeometry(radius, steps)}
        dispose={null}
      >
        <meshBasicMaterial
          ref={matRef}
          color={heatColor(clamped)}
          toneMapped={false}
          transparent
          opacity={0.95}
          side={THREE.DoubleSide}
          depthWrite={false}
          polygonOffset
          polygonOffsetFactor={-5}
          polygonOffsetUnits={-5}
        />
      </mesh>
    </group>
  );
}

// Shared like gauge geometry: selecting a node must not create a new GPU pipeline.
const SELECTION_GEOMETRY = new Map<number, THREE.RingGeometry>();
const SELECTION_MATERIAL = new THREE.MeshBasicMaterial({
  color: "#9dc0ff",
  toneMapped: false,
  transparent: true,
  opacity: 0.9,
  side: THREE.DoubleSide,
  depthWrite: false,
  polygonOffset: true,
  polygonOffsetFactor: -6,
  polygonOffsetUnits: -6,
});

function SelectionRing({ radius }: { radius: number }) {
  const ref = useRef<THREE.Mesh>(null);
  let geometry = SELECTION_GEOMETRY.get(radius);
  if (!geometry) {
    geometry = new THREE.RingGeometry(radius, radius + 0.1, 48, 1, 0, Math.PI * 1.7);
    SELECTION_GEOMETRY.set(radius, geometry);
  }
  useFrame((state) => {
    if (!ref.current) {
      return;
    }
    ref.current.rotation.z = state.clock.elapsedTime * 0.8;
    const s = 1 + 0.04 * Math.sin(state.clock.elapsedTime * 3);
    ref.current.scale.setScalar(s);
  });
  return (
    <mesh
      ref={ref}
      rotation-x={-Math.PI / 2}
      position-y={0.09}
      renderOrder={4}
      geometry={geometry}
      material={SELECTION_MATERIAL}
      dispose={null}
    />
  );
}

export const NodeMesh = memo(
  function NodeMesh({
    node,
    addr,
    variant,
    onFocus,
    telemetry,
    max,
    bearing,
  }: {
    node: PositionedNode;
    addr: string;
    /** Seeded look of this building (`buildingVariant`), computed once per city. */
    variant: BuildingVariant;
    onFocus: (pos: [number, number, number]) => void;
    telemetry?: NodeTelemetry;
    /** Per-city maxima for normalisation (height, heatmap). */
    max: CityMax;
    /** Yaw toward the open sea, from the berth (`layout/harbour.ts`). Ports only. */
    bearing?: number;
  }) {
    const [hovered, setHovered] = useState(false);
    const portal = useHtmlPortal();
    const selected = useUiStore((s) => s.selectedNode === addr);
    const select = useUiStore((s) => s.select);
    const mode = useUiStore((s) => s.viewMode);
    const config = NODE_CONFIG[node.type];
    const m = telemetry?.metrics;
    const incident = nodeIncident(telemetry);

    const memSat = memSaturation(m);
    const heat = heatValue(mode, m, max);
    const liveness = telemetry?.liveness;
    const cpuSat = cpuSaturation(m) ?? 0;
    const errorRate = m?.errorRate ?? 0;
    const rps = m?.rps ?? 0;
    const memNorm = memoryHeight(m, max);
    const visual = useMemo<VisualState>(
      () => ({
        liveness,
        cpuSat,
        errorRate,
        rps,
        memNorm,
        heat,
        mode,
        hovered,
        selected,
      }),
      [liveness, cpuSat, errorRate, rps, memNorm, heat, mode, hovered, selected],
    );
    // Ground gauge: memory saturation in health mode, active metric otherwise
    const gauge = mode === "health" ? memSat : heat;

    const liveColor = telemetry ? LIVENESS_COLORS[telemetry.liveness] : config.color;
    // A port is drawn as the quay, not as a building: it keeps every affordance
    // (gauge, selection, tooltip) but sized to the quay rather than to the plot.
    const isPort = node.isPort === true;
    const ringRadius = (isPort ? PORT_SCALE * 0.62 : config.scale) * 0.9;

    const handleHover = useCallback((value: boolean) => {
      setHovered(value);
      document.body.style.cursor = value ? "pointer" : "auto";
    }, []);
    const handleClick = useCallback(() => {
      select(addr);
      onFocus(node.position);
    }, [select, addr, onFocus, node.position]);

    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: React Three Fiber's group is a 3D scene object, not a DOM element.
      <group
        position={[node.position[0], 0, node.position[2]]}
        onPointerOver={(e) => {
          e.stopPropagation();
          handleHover(true);
        }}
        onPointerOut={() => handleHover(false)}
        onClick={(e) => {
          e.stopPropagation();
          handleClick();
        }}
      >
        {isPort ? (
          <PortModel
            bearing={bearing ?? 0}
            variant={variant}
            visual={visual}
            isDiscovered={node.isDiscovered}
          />
        ) : !node.isDiscovered ? (
          <InstancedBuilding
            addr={addr}
            type={node.type}
            variant={variant}
            visual={visual}
            fireIntensity={incident?.fireIntensity ?? 0}
            position={node.position}
            onHover={handleHover}
            onClick={handleClick}
          />
        ) : (
          <NodeModel
            addr={addr}
            type={node.type}
            variant={variant}
            visual={visual}
            isDiscovered={node.isDiscovered}
            fireIntensity={incident?.fireIntensity ?? 0}
          />
        )}

        {gauge != null && <GaugeRing radius={ringRadius + 0.05} value={gauge} />}
        {selected && <SelectionRing radius={ringRadius + 0.3} />}

        {hovered && !selected && (
          <Html
            position={[0, (isPort ? PORT_SCALE : config.scale) * 1.6 + 0.8, 0]}
            center
            portal={portal}
            style={{ pointerEvents: "none" }}
            zIndexRange={[20, 0]}
          >
            <div
              className="glass-morphic-subtle -translate-y-1/2 whitespace-nowrap rounded-xl px-3.5 py-2.5 text-[13px] text-white shadow-lg"
              style={{ borderColor: liveColor }}
            >
              <div className="flex items-center gap-2">
                <strong>{node.label}</strong>
                {telemetry && (
                  <Badge tone={LIVENESS_TONE[telemetry.liveness]} dot>
                    {telemetry.liveness}
                  </Badge>
                )}
                {node.isDiscovered && <Badge tone="ok">discovered</Badge>}
              </div>
              {node.description && (
                <div className="mt-0.5 text-[12px] text-surface-300">{node.description}</div>
              )}
              {incident && <div className="mt-1 text-[11px] text-warn">🔥 {incident.label}</div>}
              <div className="mt-0.5 text-[11px] text-surface-400">
                {node.type}
                {node.group && <span className="ml-2 text-surface-500">· {node.group}</span>}
              </div>
              {m && (
                <div className="mt-1 grid grid-cols-[auto_auto] gap-x-3 gap-y-px border-t border-white/10 pt-1 text-[11px] text-surface-200">
                  {m.cpu != null && (
                    <>
                      <span>CPU</span>
                      <span className="text-right font-mono">
                        {m.cpu.toFixed(0)}%
                        {m.cpuLimit ? (
                          <span className="text-surface-500">
                            {" "}
                            / {m.cpuLimit} core{m.cpuLimit > 1 ? "s" : ""}
                          </span>
                        ) : null}
                      </span>
                    </>
                  )}
                  {m.memoryMb != null && (
                    <>
                      <span>Mem</span>
                      <span className="text-right font-mono">
                        {formatMb(m.memoryMb)}
                        {m.memLimitMb ? (
                          <span className="text-surface-500"> / {formatMb(m.memLimitMb)}</span>
                        ) : null}
                      </span>
                    </>
                  )}
                  {netKbps(m) != null && (
                    <>
                      <span>Net</span>
                      <span className="text-right font-mono">
                        ↓{formatKbps(m.netRxKbps ?? 0)} ↑{formatKbps(m.netTxKbps ?? 0)}
                      </span>
                    </>
                  )}
                  {m.rps != null && (
                    <>
                      <span>RPS</span>
                      <span className="text-right font-mono">{m.rps}</span>
                    </>
                  )}
                  {m.latencyMs != null && (
                    <>
                      <span>Lat</span>
                      <span className="text-right font-mono">{m.latencyMs} ms</span>
                    </>
                  )}
                  {m.errorRate != null && (
                    <>
                      <span>Err</span>
                      <span className="text-right font-mono">
                        {(m.errorRate * 100).toFixed(2)}%
                      </span>
                    </>
                  )}
                </div>
              )}
              <div className="mt-1 text-[10px] text-surface-500">click for details</div>
            </div>
          </Html>
        )}
      </group>
    );
  },
  (a, b) =>
    a.node === b.node &&
    a.addr === b.addr &&
    a.variant === b.variant &&
    a.onFocus === b.onFocus &&
    a.telemetry === b.telemetry &&
    a.bearing === b.bearing &&
    a.max.memoryMb === b.max.memoryMb &&
    a.max.cpu === b.max.cpu &&
    a.max.netKbps === b.max.netKbps,
);
