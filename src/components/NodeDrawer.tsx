import { useEffect, useMemo, useState } from "react";
import { ERROR_RATE_THRESHOLD, nodeIncident, TELEMETRY_STALE_MS } from "../domain/incidents";
import { formatCores, formatKbps, formatMb, formatPercent } from "../domain/metrics/format";
import { netKbps } from "../domain/metrics/saturation";
import { LIVENESS_TONE, NODE_STYLE, nodeAddress } from "../domain/nodeStyle";
import type { MetricSample } from "../domain/telemetry";
import type { NodeTelemetry, PositionedNode } from "../domain/types";
import { nodeTarget } from "../lib/cameraTargets";
import { formatRelative } from "../lib/time";
import { useMobilityStore } from "../store/mobilityStore";
import { useUiStore } from "../store/uiStore";
import { MetricCard } from "./MetricCard";
import { UsageBar } from "./UsageBar";
import { Badge, Button, Drawer } from "./ui";

function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function NodeDrawer({
  nodes,
  telemetry,
  history,
  historyVersion,
}: {
  nodes: PositionedNode[];
  telemetry: Map<string, NodeTelemetry>;
  history: Map<string, MetricSample[]>;
  historyVersion: number;
}) {
  const selected = useUiStore((s) => s.selectedNode);
  const select = useUiStore((s) => s.select);
  const setCamera = useUiStore((s) => s.setCamera);
  const openLogsFor = useUiStore((s) => s.openLogsFor);

  // Keep the last node around while the drawer slides out.
  const [lastNode, setLastNode] = useState<PositionedNode | null>(null);
  const node = useMemo(
    () => (selected ? (nodes.find((n) => nodeAddress(n) === selected) ?? null) : null),
    [selected, nodes],
  );
  useEffect(() => {
    if (node) {
      setLastNode(node);
    }
  }, [node]);
  const shown = node ?? lastNode;

  const addr = shown ? nodeAddress(shown) : null;
  const worldKey = useMobilityStore((s) => s.worldKey);
  const ingressKey = `${worldKey}:${addr}`;
  const ingressOverride = useMobilityStore((s) => s.ingress[ingressKey]);
  const ingress = ingressOverride ?? shown?.ingress ?? false;
  const t = addr ? telemetry.get(addr) : undefined;
  const incident = nodeIncident(t);
  // biome-ignore lint/correctness/useExhaustiveDependencies: history mutates in place; the version is the intentional render signal.
  const samples = useMemo(
    () => (addr ? [...(history.get(addr) ?? [])] : []),
    [addr, history, historyVersion],
  );
  const now = useNow();
  const stale = t ? now - t.lastSeen > TELEMETRY_STALE_MS : false;
  const custom = t?.metrics.custom ? Object.entries(t.metrics.custom) : [];

  return (
    <Drawer
      open={!!node}
      onClose={() => select(null)}
      title={
        shown && (
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{ background: NODE_STYLE[shown.type].color }}
              />
              <span className="truncate text-[15px] font-semibold">{shown.label}</span>
            </div>
            <div className="mt-0.5 truncate font-mono text-[11px] text-surface-400">{addr}</div>
          </div>
        )
      }
    >
      {shown && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone="accent">{shown.type}</Badge>
            {shown.group && <Badge tone="muted">{shown.group}</Badge>}
            {t ? (
              <Badge tone={LIVENESS_TONE[t.liveness]} dot>
                {t.liveness}
              </Badge>
            ) : (
              <Badge>no telemetry</Badge>
            )}
            {shown.isDiscovered && <Badge tone="ok">discovered</Badge>}
            {stale && <Badge tone="warn">stale</Badge>}
            {t && (
              <span
                className="ml-auto text-[11px] text-surface-400"
                title={new Date(t.lastSeen).toLocaleString()}
              >
                seen {formatRelative(t.lastSeen, now)}
              </span>
            )}
          </div>

          {incident && (
            <div
              className={`rounded-xl border px-3 py-2 text-[12px] ${incident.tone === "danger" ? "border-danger/30 bg-danger/10 text-danger" : "border-warn/30 bg-warn/10 text-warn"}`}
            >
              <span aria-hidden="true">🔥 </span>
              {incident.label}
              {(t?.metrics.errorRate ?? 0) > ERROR_RATE_THRESHOLD &&
                ` · ${formatPercent(t!.metrics.errorRate!, 2)} errors`}
            </div>
          )}

          {shown.description && <p className="text-[12px] text-surface-300">{shown.description}</p>}

          <div className="flex gap-2">
            <Button variant="primary" onClick={() => setCamera(nodeTarget(shown))}>
              Focus camera
            </Button>
            <Button onClick={() => openLogsFor(nodeAddress(shown))}>Logs for this node</Button>
          </div>

          <label className="flex items-start gap-2 rounded-lg border border-white/10 p-3 text-[12px]">
            <input
              type="checkbox"
              checked={ingress}
              onChange={(event) =>
                useMobilityStore.getState().setIngress(ingressKey, event.target.checked)
              }
              className="mt-0.5 accent-cyan-400"
            />
            <span>
              Internet ingress
              <span className="mt-1 block text-[11px] text-surface-400">
                Boats represent this service’s received network traffic. Saved in this browser. RX
                may also include internal traffic.
              </span>
            </span>
          </label>

          {t &&
            (t.metrics.cpu != null || t.metrics.memoryMb != null || netKbps(t.metrics) != null) && (
              <section>
                <div className="heading mb-2">Resources</div>
                <div className="flex flex-col gap-2.5">
                  {t.metrics.cpu != null && (
                    <UsageBar
                      label="CPU"
                      value={t.metrics.cpu / 100}
                      max={t.metrics.cpuLimit}
                      format={(v) => formatCores(v, 2)}
                    />
                  )}
                  {t.metrics.memoryMb != null && (
                    <UsageBar
                      label="Memory"
                      value={t.metrics.memoryMb}
                      max={t.metrics.memLimitMb}
                      format={formatMb}
                    />
                  )}
                  {netKbps(t.metrics) != null && (
                    <div className="flex items-baseline justify-between text-[11px]">
                      <span className="text-surface-200">Network</span>
                      <span className="font-mono text-surface-300">
                        ↓ {formatKbps(t.metrics.netRxKbps ?? 0)}{" "}
                        <span className="mx-1 text-surface-500">·</span> ↑{" "}
                        {formatKbps(t.metrics.netTxKbps ?? 0)}
                      </span>
                    </div>
                  )}
                </div>
                {!t.metrics.cpuLimit && !t.metrics.memLimitMb && (
                  <div className="mt-1.5 text-[10px] text-surface-500">
                    No limits declared — set `resources.limits` in the stack to get saturation.
                  </div>
                )}
              </section>
            )}

          <section>
            <div className="heading mb-2">Metrics</div>
            {t ? (
              <div className="grid grid-cols-2 gap-2">
                <MetricCard
                  label="CPU"
                  unit="%"
                  value={t.metrics.cpu != null ? +t.metrics.cpu.toFixed(1) : undefined}
                  series={samples.map((s) => s.cpu)}
                  min={0}
                  max={100}
                  color="#7aa7ff"
                />
                <MetricCard
                  label="Memory"
                  unit="MB"
                  value={t.metrics.memoryMb}
                  series={samples.map((s) => s.memoryMb)}
                  min={0}
                  color="#b48cff"
                />
                <MetricCard
                  label="RPS"
                  value={t.metrics.rps}
                  series={samples.map((s) => s.rps)}
                  min={0}
                  color="#44cc66"
                />
                <MetricCard
                  label="Latency"
                  unit="ms"
                  value={t.metrics.latencyMs}
                  series={samples.map((s) => s.latencyMs)}
                  min={0}
                  color="#ff9a3c"
                />
                <MetricCard
                  label="Errors"
                  unit="%"
                  value={
                    t.metrics.errorRate != null
                      ? +(t.metrics.errorRate * 100).toFixed(2)
                      : undefined
                  }
                  series={samples.map((s) => (s.errorRate == null ? undefined : s.errorRate * 100))}
                  min={0}
                  color="#ff4d5e"
                />
              </div>
            ) : (
              <div className="text-[12px] text-surface-500">No live telemetry for this node.</div>
            )}
            {samples.length > 0 && (
              <div className="mt-1 text-right text-[10px] text-surface-500">
                {samples.length} samples
              </div>
            )}
          </section>

          {custom.length > 0 && (
            <section>
              <div className="heading mb-2">Custom metrics</div>
              <table className="w-full text-[12px]">
                <tbody>
                  {custom.map(([k, v]) => (
                    <tr key={k} className="border-b border-white/5 last:border-0">
                      <td className="py-1 pr-2 text-surface-300">{k}</td>
                      <td className="py-1 text-right font-mono">{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {shown.links.length > 0 && (
            <section>
              <div className="heading mb-2">Links to</div>
              <div className="flex flex-wrap gap-1">
                {shown.links.map((l) => (
                  <Badge key={l} tone="muted" onClick={() => select(`${shown.cityId}/${l}`)}>
                    {l}
                  </Badge>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </Drawer>
  );
}
