# Biomes & procedural variety

- **One biome per city** (`domain/biome.ts`): explicit `City.biome` in the JSON > provider
  `CityMeta.biome` (Swarm node label `confcity.biome`) > auto — an argmax over the type histogram
  (db → tundra, cache/queue → dunes, app → meadow, size → basalt, harbour as the floor) plus a jitter
  seeded on the city id, so five look-alike app boxes do not become five identical meadows.
  `harbour` is the pre-biome look and the default.
- The biome drives the island palette (vertex colours in `IslandMesh`), coast `ruggedness`
  (`roughen` in `layout/outline.ts`), vegetation, and the health-mode tint of the buildings
  (`buildingVariant`). Roads, kerbs, liveness colours, heatmap greys and neighbourhood slabs are
  **never** touched by it.
- **Coast noise is outward-only.** The ring road and the bridgehead roundabouts sit ≈ 2 units inside
  the smooth offset; pushing the shore inward would put them in the sea. `ruggedness: 0` must return
  the exact `roundedOffset` output (tested).
- **Per-building variety is render-only** (`domain/buildingVariant.ts`, seeded on the address):
  model among `NODE_STYLE[type].models`, yaw k·π/2, scale 0.92..1.08, hue ± 8°.
  `NODE_STYLE[type].scale` stays the footprint the layout collides on; gauge and selection rings keep
  it too. Only list a model whose GLB exists (`public/models/README.md`). Industrial models are
  generated (`scripts/build-industrial-models.ts`); their vertical stretch is capped 0.85..1.15 —
  see `building-style.md`.
- Palettes stay ≤ `#7a` per channel (bloom threshold 0.8) and desaturated so the group slabs
  (opacity 0.22) still read.
- **Vegetation** (`layout/props.ts` → `Vegetation.tsx`): each biome declares `kinds`
  (tree/pine/palm/rock/tuft), `density` and palette colours. Props are procedural
  (`buildings/propGeometry.ts`), not GLBs — a biome is a palette, an imported tree would be the same
  green on tundra as on meadow. Placement is a seeded jittered grid avoiding roads, plots and the
  shore; one `InstancedMesh` per kind per city, no per-frame work. Ceiling: 420 props per city.
- Declared, unused yet: per-island water colours (`biome.waterShallow` / `waterFoam`).

## Plot settle, lots and districts (`layout/plotSettle.ts`)

After the roads are routed, each building settles into its lattice plot. It stays square to its
street: its front (models face −Z) points at its nearest driveway mouth, snapped to the bent
grid's local axes. It shifts up to 0.8 off the plot centre, but never closer to a kerb than its
footprint allows. Its driveway doors move with it. Mouths, route points and segments never move.
Seeded by address.

- **Lots.** The top 25 % of buildings by weight (route degree + `HEFT`: db > queue > cache > app)
  claim free neighbour cells: a 2×1 lot (weight ≥ 2), or a 2×2 (weight ≥ 4). They extend along
  the frontage first, then behind, and never across a street (`seamless`) or over a cell another
  building owns or will own (`cells`). The building moves to the lot's middle, stretched
  (`PlotSettle.lot.stretch` → `BuildingVariant.stretch`). The stretched rectangle is checked
  against the kerbs and other buildings' driveways.
- **Shared blocks.** Same-group neighbours with no street between them close the gap, up to
  `BLOCK_SHIFT`, and stand side by side.
- **Districts.** A neighbourhood of ≥ 3 services (`DISTRICT_MIN`) reads as a district:
  - its buildings huddle towards the district centre;
  - they rise into a skyline, up to +60 % height at the core of a district of 5 or more;
  - they share one model per type and one hue (`buildingVariant(..., district)`).
- **Dense core, sparse outskirts.** `latticeAnneal` adds a `sprawl` term in cities of more than
  10 services, so that crowding costs more the farther a cell is from the centre.
- **Bent grid** (`layout/warp.ts`). A seeded, smooth displacement (≤ 0.55, wavelengths 27–42)
  bends every point inside the ring. It fades to zero over 1.5 pitch near the ring and is zero
  outside it. Segments are densified on a 1.5 lattice before warping, so a straight street
  becomes a gentle curve. Every point goes through the same `apply`, so the `"x,z"`
  exact-equality invariant holds.

At render time, `drawnOffset` hands the shift back as the memory footprint grows past the one
the plot was settled for; a lot keeps its offset.
