# Telemetry → visuals

All derivations are pure functions in `src/domain/metrics/` and `src/domain/incidents.ts`;
components only map values to colours and scales.

## View modes

`viewMode` in `useUiStore`: `health` (default) | `cpu` | `memory` | `network`. Toggled in the
StatusBar and TopConsumersPanel.

- **Health**: type colour + liveness; **height = memory** (log, normalised per city via `cityMax`),
  **glow = CPU saturation** (`cpu / (cpuLimit·100)`), **ground ring = memory vs limit**.
- **Heatmap modes**: grey buildings; glow and ring show `heatValue()`.
- Limits come from `MetricSnapshot.cpuLimit` / `memLimitMb`, network from `netRxKbps` / `netTxKbps`,
  city capacity from `CityMeta`.

## The city badge is the machine

Container stats cannot see the kernel, the daemon or any container outside the orchestrator — on a
real node that is most of the CPU — so the node agent reads the host procfs and sends `CityMetrics`.
`cityUsage()` prefers it; without it the badge falls back to the service sum and is tagged
`services` (a floor, not the machine's load). The tooltip always names which of the two is shown.

The utility district shows the same three figures as buildings: power station smoke ∝ CPU, water
tower level = memory, container quay = disk (`smokeRate` / `tankLevel` / `containerCount`). A figure
that is not a machine measurement gets scaffolding, never a gauge at rest. The lighthouse beam is
coloured by `worstUsage(cityUsage)` and sweeps faster as the machine saturates; it blinks on the
`services` fallback and stays dark when nothing is measured.

**Disk is city-level only.** A filesystem belongs to the box, so there is no service-sum fallback
and no `disk` view mode: the badge (city label + Cities panel) shows used/total %, the panel adds
aggregated I/O. Buildings are never touched by disk.

## Incidents

`nodeIncident()` is the single truth shared by live alerts, the Needs-attention panel and building
fires: unavailable or degraded liveness, or `errorRate > ERROR_RATE_THRESHOLD` (1 %). Telemetry
missing, unknown or older than `TELEMETRY_STALE_MS` (30 s) is *uncertain* (`telemetryUncertain()`)
and never produces an all-clear. Fires (`BuildingFire.tsx`) burn harder for unavailable services,
go out on recovery and freeze under reduced motion. Selecting an incident reveals its city.

## Ports

An ingress service (`ingress: true` in JSON, `confcity.ingress` label, or the drawer checkbox,
persisted in `mobilityStore`) **is** the island's port: `layout/harbour.ts` moves it to the
shoreline facing open sea with its own avenue to the ring. Ships (`mobility/IngressPorts.tsx`)
call at its berth at a rate driven by `netRxKbps`; the fleet is bounded. Toggling ingress re-runs the
layout, so roads rebuild and the traffic pools empty.
