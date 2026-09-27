import { Html } from "@react-three/drei";
import type { ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import { formatKbps } from "../domain/metrics/format";
import { LINK_COLORS, TERRAIN } from "../domain/nodeStyle";
import type { NodeTelemetry, ResolvedLink } from "../domain/types";
import { buildRibbon } from "./geo/ribbon";
import { useHtmlPortal } from "./htmlPortal";

const ERROR_THRESHOLD = 0.05;
const ERROR_COLOR = "#ff4d5e";
const IDLE_COLOR = "#9aa3b5";
/** Wider than the road it covers, so the hover target is comfortable. */
const HIT_MARGIN = 0.5;

/**
 * The interactive half of a link, now that vehicles carry the animation: an
 * almost invisible ribbon laid over the route, used as a raycast target and as
 * the place where errors show up as a red band.
 *
 * Everything is driven by props and hover state — no useFrame, unlike the
 * dashed animated lines it replaces.
 */
export function RouteOverlay({
  link,
  points,
  fromTelemetry,
}: {
  link: ResolvedLink;
  /** The route the traffic follows, already elevated by the caller. */
  points: [number, number, number][];
  fromTelemetry?: NodeTelemetry;
}) {
  const [hovered, setHovered] = useState(false);
  const portal = useHtmlPortal();

  const { geometry, midPoint } = useMemo(() => {
    const geometry = buildRibbon(points, TERRAIN.roadWidth + HIT_MARGIN);

    // Anchor the tooltip at half the *length* of the path, not its middle index:
    // road routes have very uneven segments.
    let total = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i]!;
      const b = points[i + 1]!;
      total += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    }
    let mid: [number, number, number] = points[0] ?? [0, 0, 0];
    let walked = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i]!;
      const b = points[i + 1]!;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      if (walked + len >= total / 2) {
        const t = len > 1e-6 ? (total / 2 - walked) / len : 0;
        mid = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
        break;
      }
      walked += len;
    }
    return { geometry, midPoint: mid };
  }, [points]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  const m = fromTelemetry?.metrics;
  const hasError = (m?.errorRate ?? 0) > ERROR_THRESHOLD;
  const baseColor = link.interCity ? LINK_COLORS.inter : LINK_COLORS.intra;

  // Resting state is invisible; an inferred link keeps a faint trace so the
  // guessed topology is still readable.
  // The error band stays subtle: it marks the route, it must not paint over the
  // roads, decks and islands underneath (several routes often share a corridor).
  // Alpha is blended in linear space, so perceived coverage is ~3× the number here.
  const color = hasError ? ERROR_COLOR : hovered ? "#ffffff" : IDLE_COLOR;
  const opacity = hovered ? 0.3 : hasError ? 0.05 : link.inferred ? 0.03 : 0;

  return (
    <>
      <mesh
        geometry={geometry}
        renderOrder={5}
        /*
         * A resting link is fully transparent, yet it still cost a draw call and
         * a screenful of blended fragments per route. `visible={false}` takes it
         * out of the render list; three's raycaster does not test visibility, so
         * the ribbon keeps catching the pointer that makes it appear again.
         */
        visible={opacity > 0}
        onPointerOver={(e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation();
          setHovered(true);
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          setHovered(false);
          document.body.style.cursor = "auto";
        }}
      >
        <meshBasicMaterial
          color={color}
          toneMapped={false}
          transparent
          opacity={opacity}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>

      {hovered && (
        <Html position={midPoint} center portal={portal} style={{ pointerEvents: "none" }}>
          <div
            className="glass-morphic-subtle whitespace-nowrap rounded-xl px-3 py-1.5 text-[12px] text-white"
            style={{ borderColor: hasError ? ERROR_COLOR : baseColor }}
          >
            <strong>{link.label || (link.interCity ? "Inter-city link" : "Link")}</strong>
            {link.inferred && <span className="ml-2 text-[10px] text-surface-400">inferred</span>}
            <div className="text-[11px] text-surface-300">
              {link.fromCityId}/{link.fromNodeId} → {link.toCityId}/{link.toNodeId}
            </div>
            {fromTelemetry && (
              <div className="mt-0.5 font-mono text-[10px] text-surface-400">
                {m?.netTxKbps != null && <span>↑ {formatKbps(m.netTxKbps)}</span>}
                {m?.netRxKbps != null && <span className="ml-2">↓ {formatKbps(m.netRxKbps)}</span>}
                {m?.rps != null && <span className="ml-2">{m.rps} rps</span>}
                {hasError && <span className="ml-2 text-danger">errors</span>}
              </div>
            )}
          </div>
        </Html>
      )}
    </>
  );
}
