import { memo, useCallback, useMemo, useState } from "react";
import type { BuildingVariant } from "../domain/buildingVariant";
import { footprintRadiusFor } from "../domain/capacity";
import { nodeIncident } from "../domain/incidents";
import { formatCores, formatKbps, formatMb, formatPercent } from "../domain/metrics/format";
import {
  type CityMax,
  cpuSaturation,
  heatValue,
  memSaturation,
  netKbps,
} from "../domain/metrics/saturation";
import { LIVENESS_COLORS, LIVENESS_TONE, NODE_STYLE } from "../domain/nodeStyle";
import type { NodeTelemetry, PositionedNode } from "../domain/types";
import { useUiStore } from "../store/uiStore";
import { GaugeRing } from "./buildings/GaugeRing";
import { InstancedBuilding } from "./buildings/InstancedBuilding";
import { NodeModel, PORT_SCALE, PortModel } from "./buildings/NodeModel";
import { SelectionRing } from "./buildings/SelectionRing";
import type { VisualState } from "./buildings/visuals";
import { SceneLabel } from "./SceneLabel";
import { Badge } from "./ui";

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
    const selected = useUiStore((s) => s.selectedNode === addr);
    const select = useUiStore((s) => s.select);
    const mode = useUiStore((s) => s.viewMode);
    const config = NODE_STYLE[node.type];
    const m = telemetry?.metrics;
    const incident = nodeIncident(telemetry);

    const memSat = memSaturation(m);
    const heat = heatValue(mode, m, max);
    const liveness = telemetry?.liveness;
    const cpuSat = cpuSaturation(m) ?? 0;
    const errorRate = m?.errorRate ?? 0;
    const rps = m?.rps ?? 0;
    const footprint = footprintRadiusFor(m);
    const visual = useMemo<VisualState>(
      () => ({
        liveness,
        cpuSat,
        errorRate,
        rps,
        footprint,
        heat,
        mode,
        hovered,
        selected,
      }),
      [liveness, cpuSat, errorRate, rps, footprint, heat, mode, hovered, selected],
    );
    // Ground gauge: memory saturation in health mode, active metric otherwise
    const gauge = mode === "health" ? memSat : heat;

    const liveColor = telemetry ? LIVENESS_COLORS[telemetry.liveness] : config.color;
    // A port is drawn as the quay, not as a building: it keeps every affordance
    // (gauge, selection, tooltip) but sized to the quay rather than to the plot.
    const isPort = node.isPort === true;
    // The rings hug the memory footprint, in quarter steps so the gauge geometry cache stays small.
    const ringRadius = isPort
      ? PORT_SCALE * 0.62 * 0.9
      : footprint != null
        ? Math.ceil(footprint * 4) / 4
        : config.scale * 0.9;

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
          <SceneLabel
            position={[0, (isPort ? PORT_SCALE : config.scale) * 1.6 + 0.8, 0]}
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
                          <span className="text-surface-500"> / {formatCores(m.cpuLimit)}</span>
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
                      <span className="text-right font-mono">{formatPercent(m.errorRate, 2)}</span>
                    </>
                  )}
                </div>
              )}
              <div className="mt-1 text-[10px] text-surface-500">click for details</div>
            </div>
          </SceneLabel>
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
