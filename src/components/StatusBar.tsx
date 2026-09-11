import { useEffect, useMemo, useState } from "react";
import { LIVENESS_TONE } from "../domain/nodeStyle";
import { QUALITY_LABELS, type QualityChoice } from "../domain/quality";
import { hasOverrides } from "../domain/qualityOverrides";
import type { Alert } from "../domain/telemetry";
import type { LivenessStatus, NodeTelemetry } from "../domain/types";
import type { ProviderInfo } from "../hooks/useTelemetryStream";
import { formatRelative } from "../lib/time";
import { type RenderMode, useQualityTier, useUiStore, type ViewMode } from "../store/uiStore";
import { ConnectionStatus } from "./ConnectionStatus";
import { TweaksPanel } from "./TweaksPanel";
import { Badge, Button, cx, GlassCard, GlassPanel, SegmentedControl, Tooltip } from "./ui";

const ORDER: LivenessStatus[] = ["healthy", "degraded", "down", "unknown"];

const VIEW_MODES: { value: ViewMode; label: string }[] = [
  { value: "health", label: "Health" },
  { value: "cpu", label: "CPU" },
  { value: "memory", label: "Memory" },
  { value: "network", label: "Network" },
];

const RENDER_MODES: { value: RenderMode; label: string }[] = [
  { value: "office", label: "Office · 30 fps" },
  { value: "smooth", label: "Smooth · 60 fps" },
];

const QUALITY_CHOICES: { value: QualityChoice; label: string }[] = (
  ["auto", "eco", "balanced", "high"] as const
).map((value) => ({ value, label: QUALITY_LABELS[value] }));

export function StatusBar({
  telemetry,
  connected,
  providers,
  lastUpdateAt,
  alerts,
  onClearAlerts,
  onRefresh,
  onReset,
  onFit,
  onSelectNode,
  labelFor,
}: {
  telemetry: Map<string, NodeTelemetry>;
  connected: boolean;
  providers: ProviderInfo[];
  lastUpdateAt: number | null;
  alerts: Alert[];
  onClearAlerts: () => void;
  onRefresh: () => void;
  onReset: () => void;
  onFit: () => void;
  onSelectNode: (addr: string) => void;
  labelFor: (addr: string) => string;
}) {
  const [popover, setPopover] = useState<"providers" | "alerts" | "display" | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const counts = useMemo(() => {
    const c: Record<LivenessStatus, number> = { healthy: 0, degraded: 0, down: 0, unknown: 0 };
    for (const t of telemetry.values()) {
      c[t.liveness]++;
    }
    return c;
  }, [telemetry]);

  const recentAlerts = alerts.slice(-20).reverse();
  const bad = alerts.filter((a) => a.tone !== "ok" && now - a.at < 60_000).length;

  const viewMode = useUiStore((s) => s.viewMode);
  const setViewMode = useUiStore((s) => s.setViewMode);
  const renderMode = useUiStore((s) => s.renderMode);
  const setRenderMode = useUiStore((s) => s.setRenderMode);
  const quality = useUiStore((s) => s.quality);
  const setQuality = useUiStore((s) => s.setQuality);
  const idle = useUiStore((s) => s.idle);
  const renderOverrides = useUiStore((s) => s.renderOverrides);
  const tier = useQualityTier();
  const displayLabel = `${renderMode === "office" ? "Office" : "Smooth"} · ${
    quality === "auto" ? `Auto (${QUALITY_LABELS[tier].toLowerCase()})` : QUALITY_LABELS[tier]
  }${idle ? " · idle" : ""}${hasOverrides(renderOverrides) ? " · tweaked" : ""}`;

  return (
    <div className="absolute left-1/2 top-4 z-30 w-max max-w-[calc(100vw-2rem)] -translate-x-1/2">
      <GlassPanel
        padding="sm"
        className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 whitespace-nowrap"
      >
        <span className="text-[11px] font-bold uppercase tracking-[0.2em]">Conf City</span>
        <span className="h-4 w-px bg-white/15" />
        <ConnectionStatus connected={connected} providerCount={providers.length} />

        <span className="h-4 w-px bg-white/15" />
        <div className="flex items-center gap-1">
          {ORDER.map((l) =>
            counts[l] > 0 || l === "healthy" ? (
              <Badge key={l} tone={LIVENESS_TONE[l]} dot title={l}>
                {counts[l]}
              </Badge>
            ) : null,
          )}
        </div>

        <span className="h-4 w-px bg-white/15" />
        <span className="text-[11px] text-surface-400">
          {lastUpdateAt ? `updated ${formatRelative(lastUpdateAt, now)}` : "no data yet"}
        </span>

        <span className="h-4 w-px bg-white/15" />
        <Tooltip label="View mode: health colours, or a heatmap of one resource">
          <SegmentedControl options={VIEW_MODES} value={viewMode} onChange={setViewMode} />
        </Tooltip>

        <span className="h-4 w-px bg-white/15" />
        <Tooltip label="Display: cadence and rendering quality. Auto measures frames and drops to 15 fps when the window is unfocused or idle; a fixed quality is never throttled.">
          <Button
            size="xs"
            aria-label="Display settings"
            aria-expanded={popover === "display"}
            className={cx(popover === "display" && "bg-white/15")}
            onClick={() => setPopover((p) => (p === "display" ? null : "display"))}
          >
            {displayLabel}
          </Button>
        </Tooltip>
        <span className="h-4 w-px bg-white/15" />
        <div className="flex items-center gap-0.5">
          <Tooltip label="Refresh snapshot">
            <Button iconOnly aria-label="Refresh" disabled={!connected} onClick={onRefresh}>
              <Icon d="M2.5 7a4.5 4.5 0 0 1 7.8-3.1M11.5 7a4.5 4.5 0 0 1-7.8 3.1M10.5 1.5v2.7H7.8M3.5 12.5V9.8h2.7" />
            </Button>
          </Tooltip>
          <Tooltip label={<span>Providers ({providers.length})</span>}>
            <Button
              iconOnly
              aria-label="Providers"
              className={cx(popover === "providers" && "bg-white/15")}
              onClick={() => setPopover((p) => (p === "providers" ? null : "providers"))}
            >
              <Icon d="M2 3.5h10M2 7h10M2 10.5h10" />
            </Button>
          </Tooltip>
          <Tooltip label="Alerts">
            <Button
              iconOnly
              aria-label="Alerts"
              className={cx("relative", popover === "alerts" && "bg-white/15")}
              onClick={() => setPopover((p) => (p === "alerts" ? null : "alerts"))}
            >
              <Icon d="M7 1.5a3.5 3.5 0 0 0-3.5 3.5v2.5L2 10h10l-1.5-2.5V5A3.5 3.5 0 0 0 7 1.5zM5.5 11.5a1.5 1.5 0 0 0 3 0" />
              {bad > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-danger px-1 text-[8px] font-bold text-white">
                  {bad}
                </span>
              )}
            </Button>
          </Tooltip>
          <span className="mx-0.5 h-4 w-px bg-white/15" />
          <Tooltip
            label={
              <span>
                Reset view <kbd className="ml-1 font-mono">R</kbd>
              </span>
            }
          >
            <Button iconOnly aria-label="Reset view" onClick={onReset}>
              <Icon d="M2 7l5-4.5L12 7M3.5 6v5.5h7V6" />
            </Button>
          </Tooltip>
          <Tooltip
            label={
              <span>
                Fit all <kbd className="ml-1 font-mono">F</kbd>
              </span>
            }
          >
            <Button iconOnly aria-label="Fit all" onClick={onFit}>
              <Icon d="M1.5 5V1.5H5M9 1.5h3.5V5M12.5 9v3.5H9M5 12.5H1.5V9" />
            </Button>
          </Tooltip>
        </div>
      </GlassPanel>

      {popover === "display" && (
        <GlassCard className="absolute left-1/2 top-full mt-2 w-[340px] -translate-x-1/2">
          <div className="heading mb-2">Display</div>
          <div className="flex flex-col gap-3 text-[12px]">
            <div className="flex flex-col gap-1">
              <span className="text-surface-400">Cadence · rendering pauses in hidden tabs</span>
              <SegmentedControl
                options={RENDER_MODES}
                value={renderMode}
                onChange={setRenderMode}
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-surface-400">
                Quality
                {quality === "auto" && (
                  <>
                    {" · currently "}
                    <span className="text-white">{QUALITY_LABELS[tier].toLowerCase()}</span>
                  </>
                )}
              </span>
              <SegmentedControl options={QUALITY_CHOICES} value={quality} onChange={setQuality} />
              <span className="text-[11px] text-surface-500">
                Auto picks a tier from the GPU, steps it from measured frames, and slows to 15 fps
                when the window is unfocused or the pointer is idle for two minutes. A fixed tier
                keeps its cadence, for wall displays.
              </span>
            </div>
            <TweaksPanel />
          </div>
        </GlassCard>
      )}

      {popover === "providers" && (
        <GlassCard className="absolute left-1/2 top-full mt-2 w-[300px] -translate-x-1/2">
          <div className="heading mb-2">Providers</div>
          {providers.length === 0 ? (
            <div className="text-[12px] text-surface-500">No provider connected.</div>
          ) : (
            providers.map((p) => (
              <div key={p.id} className="flex items-center gap-2 py-1 text-[12px]">
                <span className="h-1.5 w-1.5 rounded-full bg-ok" />
                <span className="truncate font-medium">{p.id}</span>
                <Badge tone="accent">{p.providerType}</Badge>
                <span className="ml-auto text-[10px] text-surface-400">
                  {formatRelative(p.connectedAt, now)}
                </span>
              </div>
            ))
          )}
        </GlassCard>
      )}

      {popover === "alerts" && (
        <GlassCard className="absolute left-1/2 top-full mt-2 w-[360px] -translate-x-1/2">
          <div className="mb-2 flex items-center justify-between">
            <span className="heading">Alerts</span>
            {alerts.length > 0 && (
              <Button variant="ghost" size="xs" onClick={onClearAlerts}>
                Clear
              </Button>
            )}
          </div>
          {recentAlerts.length === 0 ? (
            <div className="text-[12px] text-surface-500">All quiet.</div>
          ) : (
            <div className="glass-scroll max-h-72 overflow-y-auto">
              {recentAlerts.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => {
                    onSelectNode(a.node);
                    setPopover(null);
                  }}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] hover:bg-white/10"
                >
                  <Badge tone={a.tone} dot />
                  <span className="truncate font-medium">{labelFor(a.node)}</span>
                  <span className="truncate text-surface-300">{a.message}</span>
                  <span className="ml-auto shrink-0 text-[10px] text-surface-500">
                    {formatRelative(a.at, now)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </GlassCard>
      )}
    </div>
  );
}

function Icon({ d }: { d: string }) {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  );
}
