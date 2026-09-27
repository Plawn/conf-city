# Architecture & project structure

Annotated map of the repository. Design rules live in `CLAUDE.md`; the topic docs linked
from there explain *why* things are shaped the way they are.

## Top level

```
index.html                       Vite entry
vite.config.ts                   Vite + React + Tailwind
biome.json                       Lint / format (Biome)
justfile                         Production build + push + stack deploy (see deployment.md)
docker-compose*.yml              Base + overlays: swarm / dummy / victorialogs
.env.development                 VITE_PROXY_URL for local dev
public/models/                   Kenney CC0 GLBs + project-generated industrial buildings (README.md there)
docs/                            Topic docs
scripts/                         Build / check / benchmark scripts (below)
proxy/                           Bun telemetry proxy + providers (see providers.md)
src/                             Frontend
```

## `src/`

### Domain (pure TS, no Three.js)

```
domain/types.ts            Domain models; re-exports telemetry types from @proxy/protocol
domain/viewMode.ts         ViewMode: health colours or a heatmap of one resource
domain/camera.ts           CameraTarget { lookAt, distance?, nonce? } (nonce re-triggers the same target)
domain/quality.ts          QUALITY_PROFILES (eco|balanced|high budgets), resolveDpr, initialTier, createGovernor,
                           idle detection — see render-performance.md
domain/qualityOverrides.ts User "Tweaks" over the tier: QualityOverrides, OVERRIDE_RANGES, mergeQualityProfile,
                           parseTweaks / formatTweaks (`?tweaks=ao:0,volume:0`) — see render-performance.md
domain/telemetry.ts        MetricSample (history ring buffer), Alert
domain/telemetryMerge.ts   mergeTelemetryUpdate, reconcileMeta (Map identity kept when unchanged), pushSample,
                           appendLogs, mergeCityMetrics
domain/nodeStyle.ts        NODE_STYLE (colour/scale/models per type; first model = default), LIVENESS_COLORS,
                           TERRAIN (Y layers + road/water/bridge colours), VEHICLE_TINTS, PORT_ASSETS, nodeAddress()
domain/biome.ts            BIOMES (harbour|meadow|dunes|tundra|basalt) + resolveBiome(s) — see biomes.md
domain/buildingVariant.ts  Per-building render variety seeded on the address (model, yaw, scale, tint)
domain/color.ts            hexToHsl / hslToHex / shiftHsl / darken
domain/metrics/saturation.ts cpu/memSaturation, netKbps, cityMax, memoryHeight, heatValue — see telemetry-visuals.md
domain/metrics/format.ts   rankValue / formatRank, formatMb / Kbps / Percent / Cores, heatColor, saturationTone
domain/metrics/cityUsage.ts cityUsage (host vs services), worstUsage, usageTooltip
domain/metrics/props.ts    Utility district gauges: smokeRate, tankLevel, containerCount
domain/incidents.ts        nodeIncident / telemetryUncertain: one truth for alerts, attention list and fires
                           (ERROR_RATE_THRESHOLD 1 %, TELEMETRY_STALE_MS 30 s)
domain/mobility.ts         Construction state machine: pressure → job → upgrade (road widening, second deck,
                           metro) with the observation thresholds — see traffic-strategy.md
domain/solar.ts            Sun position from suncalc + luxon (PARIS default, preview parsing) — see lighting.md
```

### State, hooks, lib

```
store/uiStore.ts           zustand: selectedNode, cameraTarget, logPanel, toasts, viewMode, renderMode (office 30 fps /
                           smooth 60 fps, persisted), quality (auto|eco|balanced|high, persisted, `?quality=`
                           wins at load), autoTier + idle (written by QualityGovernor), renderOverrides
                           (Tweaks, persisted under "conf-city-tweaks", `?tweaks=` wins at load);
                           selectProfile / useQualityProfile merge the tier with them
store/lightingStore.ts     Solar location + clock (live | preview), location persisted
store/mobilityStore.ts     Per-world Infrastructure (finished constructions) + ingress overrides, persisted under
                           "conf-city-mobility-v1"; live stats / jobs / events for the City evolution panel
hooks/useTelemetryStream.ts WebSocket to the proxy → telemetry, nodeMeta, cityMeta, cityMetrics, logs, history,
                           requestSnapshot, subscribeLogs, queryLogs (backfill), canQueryLogs
hooks/telemetryMessages.ts handleMessage(msg, ctx): one proxy message → the hook's setters, in a fixed order
hooks/telemetryTypes.ts    ProviderInfo, LogQueryOptions, TelemetryState, PendingQuery
hooks/useAlerts.ts         Diffs liveness / errorRate per tick → Alert list (30 s cooldown)
hooks/useKeyboardShortcuts.ts  `/` search, Esc, R reset, F fit, L logs (ignored while typing)
hooks/useHashState.ts      #cities=a,b&node=city/id ↔ state
hooks/useReducedMotion.ts  prefers-reduced-motion (freezes fires, sweeps, pulses)
lib/cameraTargets.ts       resetTarget / fitAllTarget / fitCityTarget / nodeTarget
lib/frameClock.ts          Frame cap without catch-up after sleep
lib/visibleClock.ts        Wall time for observed congestion; paused while the tab is hidden
lib/time.ts                formatRelative / formatClock
lib/math.ts                clamp / clamp01 / smoothstep, TAU / EPS / GOLDEN_ANGLE
lib/random.ts              fnv1a + mulberry32 (seeded, for layout and domain)
lib/stats.ts               percentile / sum / mean
loaders/loadWorld.ts       JSON → resolved nodes + links (validation)
loaders/buildDiscoveredNodes.ts  Telemetry-only nodes → unpositioned nodes (+ new cities)
styles/glass-ui.css        GENERATED by scripts/sync-glass-css.ts (see "Glass UI" below)
```

### Layout (pure, deterministic — seeded PRNG, world coords out)

```
layout/constants.ts        PITCH (6), ROAD_OFFSET, ROUNDABOUT_*, RING_PADDING, ISLAND_PADDING, WATER_GAP…
layout/geometry.ts         vecKey / cellKey, distToSegment / distToPolyline / distToPolygon, convexHull, roundedOffset, inflateConvex, chaikin, intersections, pointInPolygon…
layout/force.ts            relax(): spring relaxation + hard collision, fixed bodies, group cohesion, bias
layout/types.ts            Vec2, RoadClass, RoadSegment, Roundabout, Driveway, RoadRoute, RoadNetwork, CityLayout,
                           Bridge, WorldLayout, linkKey()
layout/layoutCity.ts       One city: phyllotaxis seed → force relax → snap to the PITCH lattice
layout/ringRoad.ts         buildRing / ringHit / attachRing (MUTATES the ring: the hit vertex is shared by identity)
layout/roads/network.ts    buildRoadNetwork: phases over a BuildState (intra links, feeders, ring street, assembly)
layout/roads/lattice.ts    Corner lattice: cornerPos / edgeKey / cellCentre, Grid, makeGrid, walkOut, occupied
layout/roads/astar.ts      routeCorners: turn-aware A* on the lattice, shared edges cheaper
layout/roads/bridgehead.ts planBridgehead, makeRing, ringArc (Bridgehead, GateRequest)
layout/roads/buildState.ts BuildState shared by the phases, claimEdges / openDriveway / attachDriveway
layout/roads/ringStreet.ts The ring as a street: ring mouths, via-ring links, unserved buildings
layout/roads/segments.ts   Road classes (classOf, heavier), pickRoundabouts, mergeSegments, ringSegments
layout/utilityPlot.ts      Seafront stretch reserved for the machine gauges
layout/props.ts            Seeded vegetation scatter on free land
layout/outline.ts          islandOutline (roundedOffset + outward-only coast noise), zoneOutline
layout/harbour.ts          planHarbour: ingress services become the island's port (quay, berths, facing)
layout/bridges.ts          One bridge per linked city pair; each link = a BridgeCrossing
layout/layoutWorld.ts      layoutCity per city → islands relaxed in 2D → gates → roads with feeders → world coords
layout/localCity.ts        buildLocalCity (layout, shore, ring, grid, groups), planHarbours
layout/islands.ts          placeIslands (2D relax, integer offsets), planGates (bridgeheads per linked pair)
layout/translate.ts        translate / translateZone / translateRoads by integer island offsets
layout/shore.ts            Distance-to-coast grid baked per layout for the water shader
layout/bounds.ts           Bounding boxes (fallback)
```

See `roads-and-traffic.md` for the road model and its invariants.

### Geometry and simulation (pure TS, no Three.js, `bun test`)

```
geo/                       Road driving geometry: roadStyle (CLASS_STYLE, lanes, ring radii), polyline, path
                           (segments + arcs kept exact until offset), roadGraph, junctions, roundabouts,
                           drivable (THE junction of streets, roundabouts and bridges → DrivePath)
sim/traffic/               sim.ts (createSim, spawn, decide/move, advance), params.ts (tuning constants), pool.ts
                           (TrafficRoute, Sim, SoA Pool, place), frame.ts (probes, spatial hash, speedLimitAhead
                           priority rules), worldRoutes.ts (one route set for the whole world,
                           upgradeLayout), routeGeometry.ts (lane trajectories), demand.ts (telemetry → spawn
                           rates, staleness), budget.ts (lane-sampled population budget), lifecycle.ts (finite
                           journeys, stuck retirement), congestion.ts (local jams), junctions.ts (roundabout
                           reservations), reconfigure.ts (upgrade without resetting the fleet)
sim/mobility/              engine.ts (one bounded clock for every transport), metro.ts (fleet + schedule),
                           metroTrack.ts, station.ts, passengers.ts, trajectory.ts
```

### Components (the only place Three.js is imported)

Scene composition, top down:

```
App.tsx                    Data loading, discovery merge, biome resolution, panels, shortcuts, drag-drop
WorldScene.tsx             Canvas → RenderLoop → SkyEnvironment → SceneDepth → WaterPlane → cities → bridges →
                           IngressPorts → MobilitySimulation { MetroSystem, TrafficSystem } → LightingPipeline
CityScene.tsx              IslandMesh, zone slabs, city label + gauges, RoadNetworkMesh, RouteOverlays,
                           Vegetation, BuildingBatches { NodeMesh… }, utility district
RenderLoop.tsx             Owns the R3F tick: frame cap (office/smooth, 15 fps idle), skipped frames run nothing
QualityGovernor.tsx        RenderScale (render scale from the tier), governor (auto tier from measured frames),
                           idle detection (focus/pointer); exposes `__CITY_PERF__.quality`
SkyEnvironment.tsx         One sky radiance shared by the sky, the PMREM IBL and the water reflection
SceneDepth.tsx             Fog band + far plane follow the camera distance, not the world size
WaterPlane.tsx             One flat quad, node material: shore field → shallow tint + foam, ripple slope map,
                           sky reflection; water/textures.ts bakes the shore + ripple DataTextures
IslandMesh.tsx             Extruded + bevelled outline painted by vertex colours from the biome palette
RoadNetworkMesh.tsx        Whole network in 4 merged draw calls (pavements, asphalt, islands, markings)
StreetLights.tsx           Instanced lamp posts on lit classes + roundabouts
RouteOverlay.tsx           Invisible raycast ribbon per route: hover tooltip, error tint
BridgeMesh.tsx             Arched deck + railings + pylons over the deck span from src/geo/drivable.ts
NodeMesh.tsx               One building: variant model, height = memory, glow = CPU, gauge ring, selection, tooltip
BuildingFire.tsx           Flames + smoke on incident buildings, two instanced draws
Vegetation.tsx             One InstancedMesh per prop kind per city
UsageBar.tsx, MetricCard.tsx, Sparkline.tsx, NodeDrawer.tsx, LogPanel.tsx, StatusBar.tsx,
DragOverlay.tsx, CameraAnimator.tsx, ConnectionStatus.tsx, PerfTuning.tsx (PerfHud, `?perf=1`)
htmlPortal.ts              Every drei <Html> renders in one z-10 overlay under the panels
```

Sub-folders:

```
buildings/                 BuildingBatches (opaque buildings batched by city / model / 24-unit tile),
                           InstancedBuilding, instances.ts (BuildingBatch / BuildingInstances, inspectBuildings),
                           visuals.ts (colour / height targets, settled test), animationQueue.ts (sleeping tasks
                           woken by telemetry, hover, selection, lighting), industrialGeometry.ts (7 generated
                           industrial models), harbourGeometry.ts (quay + ship fallback), propGeometry.ts
geo/                       ribbon, polygon (Three.js meshes over src/geo/ shapes)
traffic/                   useVehicleGeometry / useShipGeometry (GLB → merged geometry), vehicleShadows.ts
                           (instanced blob decals); the simulation is in src/sim/traffic/
mobility/                  MobilitySimulation.tsx (drives src/sim/mobility/engine.ts), MetroSystem /
                           MetroStation, IngressPorts.tsx (ships at the berths, MAX_BOATS 24),
                           ConstructionMarkers.tsx
lighting/                  SolarLighting (sun + shadow fitting), LightingPipeline (GTAO, bloom, FXAA, lighthouse
                           volume), LocalLighting + ActiveClusteredLighting + VehicleLights (street lamps and
                           headlight pairs, clustered on WebGPU, 8 spots on WebGL2), clustered/ (TS fork of
                           three's ClusteredLightsNode with spot support, lightPacking.ts), selection.ts (selectLights,
                           BrakeTracker), shadowBounds.ts, renderer.ts (WebGPURenderer, `?renderer=webgl`),
                           rendererInitialization.ts, runtime.ts (LightingContext), passGate.ts, beaconGeometry.ts
utilities/                 Lighthouse (worst usage beacon), UtilityDistrict (power station = CPU, water tower =
                           memory, container quay = disk), districtGeometry
panels/                    SearchPanel, CitiesPanel, TopConsumersPanel, AttentionPanel, DataPanel, LegendPanel,
                           LightingPanel, MobilityPanel
ui/                        React wrappers over glass-ui CSS classes (DOM only): GlassPanel/GlassCard, Button,
                           Input, Badge, SegmentedControl, Tooltip, Drawer, Toast, cx()
```

## `proxy/`

```
server.ts                  WebSocket server (port 4001) + REST debug endpoints
protocol.ts                Shared message types — the canonical source for every telemetry type
logKey.ts                  Content-based log dedup, shared with the frontend
state.ts                   TelemetryStore (node state + metadata + log ring buffer)
connections.ts             ConnectionManager (providers + frontends + log forwarding)
providers/base.ts          BaseProvider: auto-reconnect + interval collectors + query answering
providers/docker-api.ts    Docker Engine API client + stats helpers
providers/host-stats.ts    The machine itself from HOST_PROC / HOST_FS → CityMetrics
providers/dummy.ts         Random-walk generator
providers/docker-swarm.ts  Manager side: topology, labels, limits, liveness, logs
providers/docker-node.ts   Per-node agent: container usage + host CityMetrics
providers/logsources/      LOGS_BACKEND plug-ins: docker (tail), victorialogs (tail + history) — logs-backends.md
```

## `scripts/`

```
sync-glass-css.ts          Regenerates src/styles/glass-ui.css (postinstall)
build-industrial-models.ts Regenerates public/models/industrial-*.glb from industrialGeometry.ts
traffic-soak.ts            Two accelerated 24 h simulations: bounded population, full drainage
benchmark-rendering.ts     Headless before/after frame-time runs — render-performance.md
perf-summary.ts            Aggregates benchmark reports (async GPU timestamps handled separately)
check-buildings.ts         Building batching / identity regression (headless Chromium)
check-camera.ts            Viewport resolution stays stable during orbit / zoom / damping
check-lighting.ts          Lighting scenarios (transitions, lifecycle, recovery) — lighting.md
lighting-fixture.ts        Fixture world for the lighting checks
```

## Data flow

```
Provider → proxy:  provider:hello, provider:metrics (nodes + optional cities), provider:liveness,
                   provider:logs, provider:node-meta, provider:logs-result
Proxy → provider:  query:logs                  ← the only message a provider ever receives
Proxy → frontend:  snapshot (full state + meta + cityMetrics), update (delta), logs (filtered),
                   logs-result, status (providers + capabilities)
Frontend → proxy:  subscribe:logs, unsubscribe:logs, query:logs, request:snapshot
```

The proxy re-broadcasts a full snapshot every 5 s. `useTelemetryStream` keeps `nodeMeta` / `cityMeta`
Map identity unless an entry really changed (`reconcileMeta`, `domain/telemetryMerge.ts`) and bumps
`telemetryKeysVersion` only on new keys; a fresh Map would re-run discovery → `layoutWorld` → every
route → empty the traffic pools.

## UI state

- `useUiStore` (zustand). Deep R3F components subscribe with selectors
  (`useUiStore(s => s.selectedNode === addr)`) so a selection does not re-render the city.
- Telemetry stays in `useTelemetryStream`; `world` / `visibleCities` / `search` stay in `App`.
- Camera moves go through `setCamera({ lookAt, distance, nonce })`; `nonce` re-triggers the same target.
- Rendering quality: `quality` is the user's choice, `autoTier` what the governor applies in Auto,
  `renderOverrides` the user's Tweaks (`src/domain/qualityOverrides.ts`). `selectProfile(state)` merges
  tier and tweaks behind a one-entry cache so the identity stays stable, and `useQualityProfile()`
  returns it. Consumers (lighting pipeline, sun and local lights, lighthouse, traffic, render scale)
  rebuild from the profile — destructuring the budgets they read so an unrelated tweak costs nothing;
  nothing reads budgets elsewhere.
- Keyboard: `/` focus search, `Esc` close drawer → logs → clear search, `R` reset, `F` fit, `L` logs.

## Glass UI (CSS only)

`glass-ui-solid` is a SolidJS library; its components are **never imported** (no `solid-js`).
`scripts/sync-glass-css.ts` extracts its tokens and `.glass-*` rules into `src/styles/glass-ui.css`,
wrapped in `@layer components` so Tailwind utilities still win. `src/index.css` imports Tailwind →
`glass-ui-solid/theme.css` → the vendored file, then tints `.glass-morphic*` backgrounds for
readability over the scene. Dark mode is class-based (`<html class="dark">`). Custom colours:
`ok`, `warn`, `danger`, `muted`, `node-*`.
