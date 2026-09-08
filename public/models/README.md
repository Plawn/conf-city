# 3D assets

The original low-poly GLB models are from [Kenney.nl](https://kenney.nl), all **CC0** — no attribution
required, given anyway. Everything in here is served as a static file and loaded with
`useGLTF`.

| File | Kit | Used for |
|------|-----|----------|
| `app.glb`, `app-b.glb`, `app-c.glb`, `app-e.glb` | City Kit (Commercial) 2.1 | `app` buildings (`building-skyscraper-a/b/c/e`) |
| `app-m.glb` | City Kit (Commercial) 2.1 | `app`, the squat block (`building-m`) |
| `industrial-kit/building-h/i/j/k.glb` | City Kit (Industrial) 2.0 | `db` / `cache` / `queue` variants |
| `db.glb`, `db-b.glb` | City Kit (Industrial) | Legacy tanks, no longer selected |
| `cache.glb` | Furniture Kit | Legacy screen, no longer selected |
| `queue.glb`, `queue-b.glb` | City Kit (Industrial) | Legacy chimneys, no longer selected |
| `vehicles/car.glb`, `vehicles/truck.glb` | Car Kit | traffic (instanced, `vehicles/Textures/colormap.png`) |
| `port/` | *(empty — supply your own)* | the ingress port and its cargo ships, see below |

**Two kits, two atlases, one filename.** Every Kenney GLB refers to its texture as the
relative URI `Textures/colormap.png`, resolved against the GLB's own URL — and the
Commercial and Industrial atlases are *different images* under that same name. That is why
the industrial models live in `industrial-kit/` with their own `Textures/colormap.png`
rather than next to `app*.glb`: dropped in the top folder they would silently paint
themselves with the commercial palette.

## Project-owned industrial buildings

`industrial-warehouse/sheds/datacenter.glb` are datastore hangars; `industrial-depot/cold-storage.glb` are cache depots; `industrial-terminal/containers.glb` are queue buildings. These models are created by this project, not imported from Kenney. Regenerate with `bun scripts/build-industrial-models.ts`. Each uses one merged geometry with vertex colours, no textures, and fits the existing building plots. Height variation is constrained for industrial models.

## Adding a building variant

`src/domain/nodeStyle.ts` lists, per type, the models a building may be drawn with
(`NODE_STYLE[type].models`). `buildingVariant()` picks one per node, seeded on its
address. To add one:

1. Drop the GLB here (e.g. `app-b.glb`), keeping the original's orientation: +Y up,
   footprint centred on the origin, door facing −Z.
2. Measure its height relative to the type's first model and put `1 / ratio` as `fit`,
   so every variant reaches the same reference height (the memory height factor is
   applied on top, by the renderer).
3. Append `{ path: "/models/app-b.glb", fit }` to the type's `models`.

**`fit` is uniform, so height decides the footprint.** A model taller than the reference
shrinks in plan, a shorter one grows: check `width × fit` and `depth × fit` against the
1.36-unit plot, at *any* yaw — a variant is turned by k·π/2. Reference heights are 2.88
(`app`, `building-skyscraper-a`) and 0.70 / 0.69 (the generated industrial hangars).

**Only list a file that exists.** A missing GLB is a 404 inside a Suspense boundary: the
building never resolves and the city renders without it. Left out on purpose:
`building-skyscraper-d` (5.47 tall, a needle once fitted), `building-l` / `building-n` and
the industrial `a/b/l/p/q/r/s` (still over 1.6 wide after fitting), the shipping containers
(3.05 deep), `water-tower` and the small chimneys (too thin at the reference height).

## The port and its ships

An ingress service *is* the island's port (`docs/traffic-strategy.md`). Both models are
declared in one place, `PORT_ASSETS` in `src/domain/nodeStyle.ts`:

```ts
export const PORT_ASSETS = { harbour: null, ship: null };  // "/models/port/harbour.glb"…
```

While either is `null` the corresponding object is drawn from the procedural, vertex-coloured
geometry of `src/components/buildings/harbourGeometry.ts` — no GLB is fetched at all. Drop
your files in `port/` (with their own `Textures/` if they carry an atlas, see the two-kits
trap above), point the constants at them, and the fallback disappears.

Expected orientation, same as everywhere else in the project: **+Y up, footprint centred on
the origin**, then

- the **quay** faces the sea at **−Z** — the building convention, so the one yaw `NodeMesh`
  applies (the berth's bearing) turns it toward the open water;
- the **ship**'s bow points at **+Z** — the Car Kit convention `useVehicleGeometry` relies
  on — and its **waterline sits at y = 0**, not the bottom of the hull: the instance is
  placed on the water plane without a per-model offset.

Both are rescaled by their bounding box (`PORT_SCALE` for the quay,
`SHIP_LENGTH` in `traffic/useShipGeometry.ts` for the ship), so absolute size does not
matter; proportions do. If an orientation differs, it is one `rotate*` line in the hook —
say which.

## Vegetation

There is no `nature/` folder and no Kenney Nature Kit: the props are **generated**, in
`src/components/buildings/propGeometry.ts` (tree, pine, palm, rock, tuft — vertex-coloured
from the biome's `canopy` / `trunk` / `rock`). A biome is a palette, and an imported tree
would be the same green on tundra as on meadow. Placement is `src/layout/props.ts`
(pure, seeded, road- and plot-aware); `src/components/Vegetation.tsx` draws one
`InstancedMesh` per kind per city. See `domain/biome.ts` `kinds` / `density`.
