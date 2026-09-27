# Roads & traffic

Layout (`src/layout/`) decides *where* roads are; `src/geo/` decides *how they are
drawn and driven*; `src/sim/traffic/` moves the vehicles and `src/components/TrafficSystem.tsx`
draws them. The regulation layer (finite journeys, budgets, jams, automatic constructions,
roundabout reservations) is described in `traffic-strategy.md`.

## Layout

- **European, organic**: streets come from links only, routed by A* on a PITCH-6 corner lattice
  (turn penalty, reused edges cost 0.6 → shared trunks). A road's class is how many routes share it
  (`street` 1.0 / `avenue` 1.5 / `boulevard` 2.0 wide, pavement 0.35). Runs are merged into
  `RoadSegment` polylines cut at every junction, roundabout and class change.
- Every island has a **ring road** (an avenue at `RING_PADDING` from the footprint hull; the shore is
  the parallel offset `ISLAND_PADDING` further out, grown to the machine's capacity disc when
  `CityMeta.memMb` is known; an overcrowded island is laid out dense and may spill onto a landfill
  deck — see `docs/telemetry-visuals.md`). **Every building without a link is attached to
  the ring** by a spur (`ring:<id>` route). Every route leaves its building by a driveway onto a
  street along the plot, so vehicles only ever drive on drawn asphalt.
- Roundabouts sit at crossroads and bridgeheads, ranked by routes through the corner, kept
  `ROUNDABOUT_SPACING` apart, bridgeheads first. Bridgeheads are ring vertices inserted by
  `attachRing`, which mutates the ring so the vertex is shared by identity with the route and the
  bridge.
- **One bridge per linked city pair**; each link is a `BridgeCrossing` riding its feeder streets and
  the shared deck. A second deck (construction upgrade) is a separate elevation, same crossing.
- Ingress services are held out of `layoutCity` (in the hull they would push the coast in front of
  themselves) and put back on a synthetic cell outside the ring, so `roads/` gives them a
  `ring:<id>` avenue by the isolated-building fallback (`layout/harbour.ts`).

## Exact-equality invariant

Route points, roundabout centres, bridgeheads and ring vertices come from the same arithmetic,
computed once and translated by the same integer offset; `roundabouts.ts`, `drivable.ts`,
`bridges.ts` and `roadGraph.ts` match them by `"x,z"` string or `same()`. Fillets, bends and lane
offsets are computed **after** those matches, on the render side. Never round-trip a layout point
through float math.

## Rendering (`RoadNetworkMesh`)

The network becomes a graph (`geo/roadGraph.ts`: dead ends trimmed past the last driveway, 2-arm
same-class nodes fused into bends); junctions get kerb fillets and an asphalt cap
(`geo/junctions.ts`), runs are cut at each arm's `reach`, pavements are raised with a kerb wall and
open at driveway mouths.

- Fillets scale with the narrower arm of each pair and shrink when `reach` hits its limit (half the
  run between two junctions, 0.8 of it before a dead end); cap corners sit on the run's real frame
  at `reach`, so curved ring arms leave no crack.
- Roundabout arms are cut square at `outer`; per-arm **aprons** fill down to the tarmac circle, which
  is an annulus sharing their exact angles (no crescent gap).
- A 2-arm **class change** is a tapered cap: rounded centreline, width eased over the arc, pavements
  following it; straight ones taper over `TAPER_PER_WIDTH` × the width step.
- Markings per class: centre dashes / double line + lane dashes / edge lines; zebra + stop line on
  the incoming lane of every crossing, except where a spur meets the ring road: the ring arms get
  nothing and the spur a dashed give-way line (`armMarking`); give-way ring at roundabouts.
- Bridge decks leave through `exits` (virtual arms carrying the deck class); the deck is painted its
  class colour, meets the land at road height and carries edge lines.

`scripts/road-map.ts` renders every city's road geometry top-down from a snapshot, plus a contact
sheet of each junction (`CROP`, `CROP_PX`). Y ladder in `TERRAIN`: zone 0.03 < road 0.08 < markings < pavement 0.13 < overlay.
`StreetLights` follows the `lit` classes. The parts are built by `components/roads/buildRoadGeometry.ts`
(primitives in `roads/roadPrimitives.ts`); where the gaps, dashes, zebras and driveways go is pure
layout in `geo/markings.ts`.

Vehicles do not cast into the sun shadow map. `traffic/vehicleShadows.ts` draws one instanced
blob decal per pool (flat plane, radial alpha, 0.36 × 0.72 of the normalised vehicle, scaled
with trucks) at the full pool pose, lifted 6 mm above the deck; opacity follows the sun power
(see `docs/lighting.md`). One extra draw per pool, and the sun map stays valid while traffic moves.

## Driving geometry (`geo/drivable.ts`, `geo/path.ts`)

`makeDriver(networks)` turns a city route, a ring loop or a bridge crossing into a `DrivePath`
{points, lanes, ring flags}: roundabouts circled, lanes looked up from the drawn segment under each
step, lattice corners rounded (`BEND_RADIUS` 1.2), deck ends pinned. `BridgeMesh`, `RouteOverlay`
and `TrafficSystem` all take their geometry from here.

- A route enters and leaves a roundabout by a small circle (`entryRadius()`, base 0.6, grown by the lane offset) tangent to the leg
  and to the driving circle; a leg too short shrinks it, then falls back to the radial arc.
  `next`/`prev` are never moved. `DrivePath.ring[i]` flags the steps on the ring lane.
- `geo/path.ts` keeps a path as segments + circular arcs until the last moment: an arc's offset is a
  concentric arc, whereas offsetting a polyline folds it when the local radius drops below the
  offset (that fold made outer-lane vehicles appear to reverse).
- Vehicles keep to their own right, `(-dz, dx)` in `sim/traffic/frame.ts` — the *negative* side of
  `offsetPolyline`; roundabouts circulate counter-clockwise seen from above. Lane offsets per class
  come from `laneOffsets()` (boulevard: two lanes each way) and are interpolated over `LANE_BLEND`
  at every class change and ring junction.

## Simulation (`sim/traffic/`, pure, `bun test`)

One shared simulation for every city and bridge, stepped at a fixed 30 Hz by `sim/mobility/engine.ts`.
SoA pools with swap-remove; vehicle identity is a stable id, never a pool index.

- Each vehicle lays 8 probes `PROBE_STEP` apart along its *own* lane into a spatial hash.
  Pass 0, bodies within `HIT_RADIUS` of my probes: same way → **follow**
  (`cap = v_other + (gap − MIN_GAP)·FOLLOW_GAIN`), crossing → stop `MIN_GAP` short.
- Pass 1, other vehicles' probes within `YIELD_RADIUS` of mine — who holds? Ring priority (their
  probe on a ring lane, mine not → I hold unless clear before them), then *priorité à droite* at
  plain crossings and the-later-one-holds at merges, all time-based (`timeToClear`,
  `YIELD_MARGIN`); don't-block-the-box; a hold never applies past the point of no return
  (`canStop`). The `ring` flag is per **probe**, not per vehicle.
- Held `PATIENCE` → priority **token** for `TOKEN` seconds. Stuck `STUCK_SECONDS` (20) → gradual
  retirement over `RETIRE_SECONDS`, at most one emergency retirement per second network-wide; the old
  blind "drive through" release is gone. Every journey is finite (`MAX_LIFE_SECONDS` 300, ambient
  loops one or two laps).
- Spawn refuses within `SPAWN_GAP` of a vehicle ahead, is smoothed over 5 s, and stops when the
  lane-sampled budget (`budget.ts`) or the space is exhausted. Rates: links follow the source node's
  throughput, unlinked buildings a fixed trickle, the ring's ambient loops the **host CPU**
  (`cityUsage().cpuPct`). Telemetry absent or stale (30 s) produces no service traffic.
- Roundabouts (`sim/traffic/junctions.ts`): one reserved crossing at a time per roundabout, the exit
  checked before admission, at most three approaching vehicles per physical entry.

`upgradeLayout` / `reconfigure.ts` widen lanes or add a deck without resetting the fleet: identity,
age and progress survive. Hiding a city stops its entries and removes its traffic.
