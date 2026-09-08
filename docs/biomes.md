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
