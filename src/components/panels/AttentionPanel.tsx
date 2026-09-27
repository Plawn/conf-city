import { useEffect, useMemo, useState } from "react";
import { ERROR_RATE_THRESHOLD, nodeIncident, telemetryUncertain } from "../../domain/incidents";
import { formatPercent } from "../../domain/metrics/format";
import { nodeAddress } from "../../domain/nodeStyle";
import type { City, NodeTelemetry, PositionedNode } from "../../domain/types";
import { useUiStore } from "../../store/uiStore";
import { Badge, Button } from "../ui";

export function AttentionPanel({
  nodes,
  cities,
  telemetry,
  connected,
  onPick,
}: {
  nodes: PositionedNode[];
  cities: City[];
  telemetry: Map<string, NodeTelemetry>;
  connected: boolean;
  onPick: (addr: string) => void;
}) {
  const selected = useUiStore((s) => s.selectedNode);
  const openLogsFor = useUiStore((s) => s.openLogsFor);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const cityNames = useMemo(() => new Map(cities.map((c) => [c.id, c.name])), [cities]);
  const rows = useMemo(
    () =>
      nodes
        .flatMap((node) => {
          const addr = nodeAddress(node);
          const t = telemetry.get(addr);
          const incident = nodeIncident(t);
          return incident ? [{ node, addr, telemetry: t!, incident }] : [];
        })
        .sort(
          (a, b) =>
            a.incident.priority - b.incident.priority ||
            a.node.label.localeCompare(b.node.label) ||
            a.addr.localeCompare(b.addr),
        ),
    [nodes, telemetry],
  );
  const uncertain = nodes.filter((n) =>
    telemetryUncertain(telemetry.get(nodeAddress(n)), now),
  ).length;
  const down = rows.filter((r) => r.incident.kind === "down").length;
  const degraded = rows.filter((r) => r.incident.kind === "degraded").length;
  const errors = rows.filter((r) => r.incident.kind === "errors").length;

  return (
    <section aria-label="Needs attention">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="heading flex items-center gap-1.5">
          <span aria-hidden="true">🔥</span> Needs attention
        </h2>
        <span className="text-[10px] text-surface-400">All cities</span>
      </div>
      <div role="status" className="space-y-2 text-[11px]">
        {!connected && (
          <p className="rounded-lg border border-warn/25 bg-warn/10 px-2.5 py-2 text-warn">
            Telemetry disconnected.{" "}
            {telemetry.size > 0 ? "Showing last reported state." : "Waiting for live data."}
          </p>
        )}
        {rows.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {down > 0 && <Badge tone="danger">× {down} unavailable</Badge>}
            {degraded > 0 && <Badge tone="warn">! {degraded} degraded</Badge>}
            {errors > 0 && <Badge tone="warn">! {errors} with errors</Badge>}
          </div>
        ) : connected ? (
          <p className={uncertain > 0 || nodes.length === 0 ? "text-surface-300" : "text-ok"}>
            {nodes.length === 0
              ? "No services to monitor."
              : uncertain > 0
                ? "Waiting for complete health data."
                : "✓ No incidents detected"}
          </p>
        ) : null}
        {connected && uncertain > 0 && (
          <p className="text-surface-400">
            {uncertain} service{uncertain > 1 ? "s" : ""} with missing, unknown or stale data.
          </p>
        )}
      </div>
      {rows.length > 0 && (
        <ul className="glass-scroll mt-2 max-h-64 space-y-1.5 overflow-y-auto pr-1">
          {rows.map(({ node, addr, telemetry: t, incident }) => (
            <li
              key={addr}
              className={`rounded-xl border ${selected === addr ? "border-accent-400/60 bg-accent-400/10" : "border-white/10 bg-white/[0.03]"}`}
            >
              <button
                type="button"
                aria-label={`Inspect ${node.label} in ${cityNames.get(node.cityId) ?? node.cityId}: ${incident.label}`}
                aria-pressed={selected === addr}
                onClick={() => onPick(addr)}
                className="flex w-full cursor-pointer gap-2 rounded-lg p-2.5 text-left hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-accent-400"
              >
                <span
                  aria-hidden="true"
                  className={incident.tone === "danger" ? "text-danger" : "text-warn"}
                >
                  {incident.kind === "down" ? "×" : "!"}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-semibold">{node.label}</span>
                  <span className="block truncate text-[10px] text-surface-400">
                    {cityNames.get(node.cityId) ?? node.cityId}
                  </span>
                  <span
                    className={`mt-1 block text-[11px] ${incident.tone === "danger" ? "text-danger" : "text-warn"}`}
                  >
                    {incident.label}
                    {(t.metrics.errorRate ?? 0) > ERROR_RATE_THRESHOLD &&
                      ` · ${formatPercent(t.metrics.errorRate!, 2)} errors`}
                  </span>
                  {(!connected || telemetryUncertain(t, now)) && (
                    <span className="block text-[10px] text-surface-400">Last reported state</span>
                  )}
                </span>
                <span aria-hidden="true" className="text-surface-400">
                  ↗
                </span>
              </button>
              <div className="flex justify-end border-t border-white/5 px-2 py-1">
                <Button
                  variant="ghost"
                  size="xs"
                  aria-label={`View logs for ${node.label} in ${cityNames.get(node.cityId) ?? node.cityId}`}
                  onClick={() => {
                    onPick(addr);
                    openLogsFor(addr);
                  }}
                >
                  View logs →
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
