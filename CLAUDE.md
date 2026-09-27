# Conf City

3D infrastructure visualization — each server/cluster is a **city** on its own island, each
service a **building**. Intra-city links become shared Manhattan roads, inter-city links become
bridges, vehicles ride them at a density driven by the source node's throughput.

## Stack

- **Frontend**: React 19 + TypeScript + Three.js r185 (`@react-three/fiber` + `@react-three/drei`),
  `WebGPURenderer` with WebGL2 fallback (`?renderer=webgl`), node materials, no EffectComposer
- **Proxy**: Bun WebSocket server — collects telemetry from providers, broadcasts to frontends
- **Tooling**: Vite, Bun (`bun install / run / test`), Biome (lint + format), strict TS with
  `noUncheckedIndexedAccess`
- **Styling**: Tailwind CSS v4 + vendored glass-ui-solid **CSS only**
- **State**: zustand (`uiStore`, `lightingStore`, `mobilityStore`)
- **Assets**: Kenney.nl CC0 GLBs + project-generated industrial buildings (`public/models/`)
- **Deployment**: Docker (nginx + Bun), Docker Swarm via the `justfile`

## Commands

```sh
bun run dev          # Vite dev server (port 4000)
bun run build        # typecheck + production build to dist/
bun run typecheck    # tsc --noEmit
bun run lint         # biome check .   (lint:fix / format to write)
bun test             # pure-TS tests in tests/ (mirrors src/; fixtures in tests/fixtures/)
bun run proxy        # telemetry proxy (port 4001)
bun run dummy        # dummy data provider
bun run sync:glass   # regenerate src/styles/glass-ui.css (also on postinstall)
bun scripts/traffic-soak.ts            # accelerated 24 h traffic check
bun scripts/build-industrial-models.ts # regenerate industrial-*.glb
```

Headless checks and benchmarks (`scripts/check-*.ts`, `benchmark-rendering.ts`) need a built
preview and Chromium — see `docs/render-performance.md`. Docker and `just` recipes:
`docs/deployment.md`.

## Architecture rules

- **domain ≠ render** — no Three.js imports outside `src/components/`. `src/domain/` and
  `src/layout/`, `src/geo/` (road driving geometry) and `src/sim/` (traffic + mobility
  simulation) are pure, deterministic (seeded PRNG, never `Math.random`), import neither
  Three.js, React nor `src/components/`, and are unit-tested (`tests/` mirrors `src/`).
- Components receive **pre-computed positioned data**; no layout logic in render.
- `proxy/protocol.ts` is the single source of truth for telemetry types; the frontend imports it
  through `@proxy/`, `src/domain/types.ts` re-exports it.
- Node addresses are always `"cityId/nodeId"`.
- **Exact-equality invariant** (roads): route points, roundabout centres, bridgeheads and ring
  vertices are matched by `"x,z"` string across layout, drivable geometry and bridges. Compute them
  once, translate by integer offsets, never round-trip a layout point through float math.
- **Providers write disjoint fields.** The Swarm manager provider and the per-node agent merge into
  the same node last-writer-wins per key; an overlap makes values flap.
- Keep `nodeMeta` / `cityMeta` Map identity stable across snapshots — a new Map re-runs discovery
  → `layoutWorld` → every route → empties the traffic pools.
- Per-frame work is budgeted: `RenderLoop` owns the tick, animations sleep when settled, fixed
  meshes never rebuild matrices, instanced draws over per-object meshes. Measure before and after
  (`?perf=1`, `docs/render-performance.md`).
- **Render budgets come from `src/domain/quality.ts`** (pixels, AO, bloom, shadows, light and
  vehicle counts), read through `useQualityProfile()` (the tier merged with the user's Tweaks
  overrides); never a local constant. Headless scripts force `quality=high` so measurements stay
  comparable.
- `glass-ui-solid` components are **never imported** (no `solid-js`); only its extracted CSS is used.
- Palettes stay ≤ `#7a` per channel (bloom threshold 0.8); biomes never touch roads, kerbs,
  liveness colours or heatmap greys.
- 3D assets load with `useGLTF`; only list a model in `NODE_STYLE` whose GLB exists.

## Key types (`proxy/protocol.ts`)

- `NodeType` = `"app" | "db" | "cache" | "queue"`
- `MetricSnapshot` — cpu, memoryMb, rps, latencyMs, errorRate, cpuLimit, memLimitMb, netRxKbps, netTxKbps, custom
- `NodeTelemetry` — liveness + metrics + lastSeen
- `NodeMeta` — type, label, description, group, links, linksInferred, hidden, ingress
- `CityMeta` — label, cpuCores, memMb, biome (capacity + look)
- `CityMetrics` — the **machine's own** usage from the host procfs: cpuUsedCores, memUsedMb, load1, disk space + I/O
- `LogEntry` — timestamp, node, level, message
- `PositionedNode` — `ResolvedNode` + `position`, optional `isDiscovered` / `isPort`

## Docs

| Topic | File |
|---|---|
| Annotated file tree, data flow, UI state, Glass UI | `docs/architecture.md` |
| Providers, proxy, log backfill, Swarm split, auto-discovery | `docs/providers.md` |
| Docker, `justfile`, registry, agent mounts | `docs/deployment.md` |
| Swarm labels (`confcity.*`) | `docs/swarm-labels.md` |
| Log backends (`LOGS_BACKEND`) | `docs/logs-backends.md` |
| View modes, city badge, disk, incidents, ports | `docs/telemetry-visuals.md` |
| Biomes, building variants, vegetation | `docs/biomes.md` |
| Road layout, invariants, driving geometry, simulation rules | `docs/roads-and-traffic.md` |
| Traffic regulation, budgets, automatic constructions, metro | `docs/traffic-strategy.md` |
| Sun, sky, local lights, lighthouse volume | `docs/lighting.md` |
| Building batching, benchmarks, functional checks | `docs/render-performance.md` |
| Industrial building style sheet | `docs/building-style.md` |
