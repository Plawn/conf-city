# Telemetry → visuals

All derivations are pure functions in `src/domain/metrics/` and `src/domain/incidents.ts`;
components only map values to colours and scales.

## View modes

`viewMode` in `useUiStore`: `health` (default) | `cpu` | `memory` | `network`. Toggled in the
StatusBar and TopConsumersPanel.

- **Health**: type colour + liveness; **footprint = memory used**, **roof smoke = CPU cores used**
  (height is the model's own, so a quiet city is never flat),
  **glow = CPU saturation** (`cpu / (cpuLimit·100)`), **ground ring = memory vs limit**.
- **Heatmap modes**: grey buildings; glow and ring show `heatValue()`.
- Limits come from `MetricSnapshot.cpuLimit` / `memLimitMb`, network from `netRxKbps` / `netTxKbps`,
  city capacity from `CityMeta`.

## The land is RAM

`src/domain/capacity.ts` gives island and buildings one unit: `LOT_MB` (1 GB) of machine memory
buys one lattice lot (`PITCH²`) of island, and a building fills its plot once its service uses that
much.

- **Footprint**: `footprintRadiusFor` = `FOOTPRINT_MAX · √(memoryMb / LOT_MB)`, clamped to
  `FOOTPRINT_MIN..FOOTPRINT_MAX` (0.5..2.1). Area ∝ RAM, absolute (comparable across cities), damped
  on the x/z scale of the building's size group. It never re-runs the layout: the layout's
  `footprintRadius` is unchanged, and 2.1 still clears the streets and ring.
- **Smoke**: `serviceSmoke` = `log1p(20·cores) / log1p(20·SERVICE_SMOKE_REF_CORES)` (0.1 core ≈ 0.3,
  2 cores → full). `BuildingSmoke` is one instanced draw per city: `allotPuffs` gives each roof
  `PUFFS_PER_CHIMNEY · smoke` puffs (absolute — an idle city stays clear; below `MIN_SMOKE`, ≈ 2 % of a
  core, none), scaled down to the quality profile's `chimneyPuffs` when over budget. Column height,
  width and soot follow the smoke.
- **Island**: `islandShore` unions the buildings' shore with a disc of `capacityRadius(memMb)`
  (`CityMeta.memMb`, from Swarm node resources). The island never shrinks below the buildings' shore.
  `crowding` = the buildings' shore area / capacity disc area. With no `memMb` the island keeps the
  old shape and no crowding value.
- **Overcrowded**: above 1, `buildLocalCity` re-runs `layoutCity(…, dense)` — tighter spiral, no
  padding between plots, stronger pull to the centre, links at their usual rest length — and flags
  the city `packed`. If even packed it overflows, the capacity disc stays natural ground
  (`CityLayout.land`, what `IslandMesh` and the vegetation use) and the rest of the straight-edged
  outline is a concrete deck on piles over the water (`Landfill`). A packed island without landfill
  has a concrete beach instead. Either way the city badge shows `crowded`.

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

The power station is a nuclear plant on a double waterfront slot (`SLOT_WEIGHTS` in
`layout/utilityPlot.ts`): two cooling towers taller than the lighthouse, a reactor dome and a vent
stack. Its plume follows `plumeLevel`, which rises in about 4 s and dies away over about 40 s, so a
spike is still visible a minute later. The wind lays the plume along the shore, never over the city.
Past 75 % (`smokeSurge`, full at 95 %) the plume climbs higher and turns sooty, and the towers'
red obstruction lights blink. The puff count is the `plumePuffs` quality budget.

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
