import { useLayoutEffect, useMemo } from "react";
import * as THREE from "three";
import { BIOMES, DEFAULT_BIOME } from "../domain/biome";
import { type BuildingVariant, buildingVariant } from "../domain/buildingVariant";
import { cityUsage, usageTooltip } from "../domain/metrics/cityUsage";
import { formatCores, formatMb, saturationTone } from "../domain/metrics/format";
import { cityMax } from "../domain/metrics/saturation";
import { nodeAddress, TERRAIN } from "../domain/nodeStyle";
import type {
  City,
  CityMeta,
  CityMetrics,
  NodeTelemetry,
  PositionedNode,
  ResolvedLink,
} from "../domain/types";
import type { DrivePath } from "../geo/drivable";
import { makeDriver } from "../geo/drivable";
import type { DeckExit } from "../geo/roadGraph";
import { computeBounds } from "../layout/bounds";
import { type CityLayout, type GroupZone, linkKey, type Vec2 } from "../layout/types";
import { fnv1a } from "../lib/random";
import { BuildingBatches } from "./buildings/BuildingBatches";
import { IslandMesh } from "./IslandMesh";
import { NodeMesh } from "./NodeMesh";
import { RoadNetworkMesh } from "./RoadNetworkMesh";
import { RouteOverlay } from "./RouteOverlay";
import { SceneLabel } from "./SceneLabel";
import { Badge, Tooltip } from "./ui";
import { Lighthouse } from "./utilities/Lighthouse";
import { UtilityDistrict } from "./utilities/UtilityDistrict";
import { Vegetation } from "./Vegetation";

type Vec3 = [number, number, number];

/** Hover ribbons float just above the asphalt so the raycast wins over the road. */
/** Above the pavement, so hovering a link is never occluded by the ground stack. */
const OVERLAY_Y = TERRAIN.pavementY + 0.02;
/** Neighbourhood slabs keep the height they had as AABBs. */
const ZONE_Y = TERRAIN.zoneY;
const GROUP_OPACITY = 0.22;
/** The discovery district is a hint, not a neighbourhood: same slab, muted and fainter. */
const DISCOVERED_COLOR = "#9aa3b5";
const DISCOVERED_OPACITY = 0.1;

export function CityScene({
  city,
  nodes,
  links,
  layout,
  visible,
  onFocus,
  telemetry,
  meta,
  hostMetrics,
  exits,
}: {
  city: City;
  nodes: PositionedNode[];
  links: ResolvedLink[];
  /** Island, streets and neighbourhood zones. Absent → minimal ground, no roads. */
  layout?: CityLayout;
  visible: boolean;
  onFocus: (pos: [number, number, number]) => void;
  telemetry?: Map<string, NodeTelemetry>;
  meta?: CityMeta;
  hostMetrics?: CityMetrics;
  /** Bridge decks leaving this city, so the bridgehead pavements open for them. */
  exits?: DeckExit[];
}) {
  const cityNodes = useMemo(() => nodes.filter((n) => n.cityId === city.id), [nodes, city.id]);
  const biome = BIOMES[layout?.biome ?? DEFAULT_BIOME];
  // One look per building, fixed by its address and the island's biome — never per tick.
  const variants = useMemo(() => {
    const out = new Map<string, BuildingVariant>();
    for (const n of cityNodes) {
      const addr = nodeAddress(n);
      out.set(addr, buildingVariant(addr, n.type, biome));
    }
    return out;
  }, [cityNodes, biome]);
  const cityLinks = useMemo(
    () => links.filter((l) => !l.interCity && l.fromCityId === city.id),
    [links, city.id],
  );

  // Only the fallback needs an AABB; with a layout the shore is the ground.
  const fallbackBounds = useMemo(
    () => computeBounds(cityNodes, 3) ?? { cx: 0, cz: 0, width: 4, height: 4 },
    [cityNodes],
  );
  const anchor: Vec2 = layout ? layout.center : [fallbackBounds.cx, fallbackBounds.cz];

  const driver = useMemo(() => (layout ? makeDriver([layout.roads]) : null), [layout]);

  // Ingress services are drawn as the island's port, turned toward the open sea:
  // the berth's bearing, not the seeded yaw a building would get.
  const berthBearings = useMemo(
    () => new Map((layout?.harbour?.berths ?? []).map((b) => [b.nodeId, b.bearing])),
    [layout],
  );

  // One drivable route per intra-city link, shared by the hover overlay and the
  // traffic (same polyline, different Y).
  const routed = useMemo(() => {
    const roads = layout?.roads;
    if (!roads || !driver) {
      return [];
    }
    const out: { key: string; link: ResolvedLink; road: DrivePath; overlay: Vec3[] }[] = [];
    const occurrences = new Map<string, number>();
    for (const link of cityLinks) {
      const routeKey = linkKey(link);
      const route = roads.routes.get(routeKey);
      // Defensive: a link the road builder could not path stays invisible.
      if (!route) {
        continue;
      }
      const road = driver.street(route.points);
      const occurrence = occurrences.get(routeKey) ?? 0;
      occurrences.set(routeKey, occurrence + 1);
      out.push({
        key: `${routeKey}-${occurrence}`,
        link,
        road,
        overlay: road.points.map(([x, , z]) => [x, OVERLAY_Y, z] as Vec3),
      });
    }
    return out;
  }, [layout, driver, cityLinks]);

  const cityTelemetry = useMemo(
    () => cityNodes.map((n) => telemetry?.get(nodeAddress(n))),
    [cityNodes, telemetry],
  );
  const max = useMemo(() => cityMax(cityTelemetry), [cityTelemetry]);
  const usage = useMemo(
    () => cityUsage(cityTelemetry, meta, hostMetrics),
    [cityTelemetry, meta, hostMetrics],
  );

  if (!visible) {
    return null;
  }

  return (
    <group>
      {layout ? (
        <>
          <IslandMesh outline={layout.outline} palette={biome} />
          {/* Scattered before the roads are drawn but placed around them: the
            scatter rejects anything within a road's clearance, so the order here
            is only paint order. */}
          <Vegetation layout={layout} biome={biome} />
          <RoadNetworkMesh
            segments={layout.roads.segments}
            roundabouts={layout.roads.roundabouts}
            driveways={layout.roads.driveways}
            exits={exits}
          />
        </>
      ) : (
        /* No layout: a bare slab under the buildings, no streets. */
        <mesh
          position={[fallbackBounds.cx, -0.05, fallbackBounds.cz]}
          rotation={[-Math.PI / 2, 0, 0]}
          receiveShadow
        >
          <planeGeometry args={[fallbackBounds.width, fallbackBounds.height]} />
          <meshStandardMaterial color={biome.ground} />
        </mesh>
      )}

      {/* Neighbourhoods */}
      {layout?.groups.map((zone) => (
        <ZoneSlab
          key={zone.name}
          zone={zone}
          color={groupColor(zone.name)}
          opacity={GROUP_OPACITY}
        />
      ))}
      {layout?.discoveredZone && (
        <ZoneSlab
          zone={layout.discoveredZone}
          color={DISCOVERED_COLOR}
          opacity={DISCOVERED_OPACITY}
        />
      )}

      {/* City name label + capacity gauge */}
      <SceneLabel position={[anchor[0], 4, anchor[1]]}>
        <div className="flex items-center gap-2 whitespace-nowrap rounded-full border border-white/10 bg-black/30 px-3 py-0.5 text-[12px] font-semibold uppercase tracking-[0.2em] text-surface-200 backdrop-blur-sm">
          <span>{city.name}</span>
          {/* A machine can be worth a badge with no visible service: the host sample
              still describes it. */}
          {(usage.nodeCount > 0 || usage.fromHost || usage.diskPct != null) && (
            <span className="flex items-center gap-1 tracking-normal normal-case">
              <Tooltip label={usageTooltip(usage, "cpu")}>
                <Badge tone={saturationTone(usage.cpuPct != null ? usage.cpuPct / 100 : undefined)}>
                  {usage.cpuPct != null
                    ? `${Math.round(usage.cpuPct)}% CPU`
                    : formatCores(usage.cpuUsedCores, 1)}
                </Badge>
              </Tooltip>
              <Tooltip label={usageTooltip(usage, "mem")}>
                <Badge tone={saturationTone(usage.memPct != null ? usage.memPct / 100 : undefined)}>
                  {usage.memPct != null
                    ? `${Math.round(usage.memPct)}% mem`
                    : formatMb(usage.memUsedMb)}
                </Badge>
              </Tooltip>
              {/* Disk is host-only: no container sum can stand in for a filesystem. */}
              {usage.diskPct != null && (
                <Tooltip label={usageTooltip(usage, "disk")}>
                  <Badge tone={saturationTone(usage.diskPct / 100)}>
                    {`${Math.round(usage.diskPct)}% disk`}
                  </Badge>
                </Tooltip>
              )}
              {/* The machine is measured on the host; without it the badge is only the
                  services we can see, which is a floor, not the machine's load. */}
              {!usage.fromHost && <span className="text-[10px] text-surface-500">services</span>}
            </span>
          )}
        </div>
      </SceneLabel>

      {/* The machine itself, on its reserved coastal plot: the beacon burns the
        worst of CPU / memory / disk, readable from across the room. */}
      {layout?.utilityPlot?.slots[0] && (
        <Lighthouse
          slot={layout.utilityPlot.slots[0]}
          scale={layout.utilityPlot.scale}
          usage={usage}
        />
      )}
      {layout?.utilityPlot && <UtilityDistrict plot={layout.utilityPlot} usage={usage} />}

      {routed.map(({ key, link, overlay }) => (
        <RouteOverlay
          key={key}
          link={link}
          points={overlay}
          fromTelemetry={telemetry?.get(`${link.fromCityId}/${link.fromNodeId}`)}
        />
      ))}

      <BuildingBatches>
        {cityNodes.map((node) => {
          const addr = nodeAddress(node);
          const variant = variants.get(addr) ?? buildingVariant(addr, node.type, biome);
          return (
            <NodeMesh
              key={node.id}
              node={node}
              addr={addr}
              variant={variant}
              onFocus={onFocus}
              telemetry={telemetry?.get(addr)}
              max={max}
              bearing={berthBearings.get(node.id)}
            />
          );
        })}
      </BuildingBatches>
    </group>
  );
}

/**
 * One neighbourhood (or the discovery district) as a flat tinted polygon.
 *
 * Same trick as IslandMesh: a `THREE.Shape` lives in XY, so the outline's world
 * `z` is mirrored on the way in and the `-π/2` rotation around X puts it back.
 */
function ZoneSlab({ zone, color, opacity }: { zone: GroupZone; color: string; opacity: number }) {
  const geometry = useMemo(() => {
    if (zone.outline.length < 3) {
      return null;
    }
    const shape = new THREE.Shape();
    const first = zone.outline[0]!;
    shape.moveTo(first[0], -first[1]);
    for (let i = 1; i < zone.outline.length; i++) {
      const p = zone.outline[i]!;
      shape.lineTo(p[0], -p[1]);
    }
    shape.closePath();
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, ZONE_Y, 0);
    return geo;
  }, [zone.outline]);

  useLayoutEffect(() => {
    if (!geometry) {
      return;
    }
    return () => geometry.dispose();
  }, [geometry]);

  if (!geometry) {
    return null;
  }

  return (
    <group>
      {/*
        No depth write, and deliberately *no* polygon offset: the slab is a tint
        on the ground, it must lose the depth test to everything built on top of
        it. Pulling it towards the camera — which is what a negative offset does
        — is exactly what made the district repaint the streets crossing it. Its
        separation from the island is `zoneY`, which is what keeps it from
        z-fighting instead.
      */}
      <mesh geometry={geometry} renderOrder={1}>
        <meshStandardMaterial color={color} transparent opacity={opacity} depthWrite={false} />
      </mesh>
      <SceneLabel position={[zone.center[0], 0.02, zone.center[1]]} zIndexRange={[5, 0]}>
        <div
          className="whitespace-nowrap rounded px-1.5 py-px text-[9px] font-semibold uppercase tracking-[0.18em]"
          style={{ color, background: "rgba(0,0,0,0.35)" }}
        >
          {zone.name}
        </div>
      </SceneLabel>
    </group>
  );
}

const GROUP_PALETTE = ["#7c9cff", "#ffb86b", "#6be3c2", "#ff8fb1", "#c9a7ff", "#ffe36b", "#8be0ff"];

/** Stable colour per group name. */
function groupColor(name: string): string {
  return GROUP_PALETTE[fnv1a(name) % GROUP_PALETTE.length]!;
}
