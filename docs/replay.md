# Replay — "Infra Wrapped" videos

A separate mode that plays a **hand-written scenario** instead of live telemetry: islands rise
from the sea, buildings grow, demolished ones explode, roads and bridges follow the links, and a
camera director frames each event. Used to film the year's infrastructure work.

```
/?replay=/scenarios/example.json            interactive player (scrub, speed, free camera)
/?replay                                    empty player: pick a file with « Open scenario… »
/?replay=/scenarios/example.json&cinema=1   no transport bar, overlay only (screen recording)
bun scripts/render-replay.ts public/scenarios/example.json out/replay/2026.mp4   MP4 export
```

**Open scenario…** in the bar loads a local JSON file in place of the current scenario (it
never leaves the browser; the export still reads a file from disk). An invalid file shows
`parseScenario`'s problem list and keeps the current scenario.

## Scenario format

A scenario is a `World` (`src/data/sample.json` shape) holding **everything that ever existed**
over the period, each piece dated. Types: `Scenario` in `src/domain/scenario.ts`.

| Field | Meaning |
|---|---|
| `title`, `subtitle` | Intro card |
| `start`, `end` | ISO dates bounding the timeline (mapped linearly onto `durationSec`) |
| `durationSec` | Video seconds between `start` and `end` |
| `introSec` / `outroSec` | Wide shot before / after (default 3 / 4) |
| `rampSec` | Seconds a building takes to rise or sink (default 1.2) |
| `sunTime` | ISO instant the sun is frozen at |
| `cities[]` | `id`, `name`, `biome`, `meta` (`CityMeta`: `memMb` sizes the island), `nodes[]` |
| `cities[].nodes[]` | `GraphNode` fields; `links` items are a node id or `{ "to", "since", "until" }` |
| `links[]` | Inter-city links `{ "from": "city/node", "to": "city/node" }` → bridges |

Every city, node and link takes optional `since` / `until` (ISO dates; omitted = from the start /
until the end). Lifetimes are clipped: a node never outlives its city, a link never outlives
either end. `parseScenario` lists every problem at once.

A skeleton from today's infrastructure (everything present from 1 January), then date by hand:

```sh
bun scripts/scenario-from-snapshot.ts                       # live proxy (ws://localhost:4001/ws/frontend)
bun scripts/scenario-from-snapshot.ts snapshot.json --year 2026 --out public/scenarios/2026.json
```

## How it works

- **Frozen layout** — `planWorld` lays out the union of the whole year once; `assembleWorld(plan,
  active)` rebuilds roads, gates and bridges for the pieces alive at an instant, reusing the
  union's positions and utility plots. Nothing moves when a city grows, and the exact-equality
  invariant holds (`tests/layout/pinnedLayout.test.ts`).
- **Everything is a function of video time `t`** — `presenceAt(timeline, t)` gives each entity a
  presence in [0, 1] with eased ramps. Buildings scale up from the ground, islands rise from
  the sea (`RisingCity`), and leaving links and islands sink. `activeKey(presence)` only changes
  at an event, so React reassembles the world at events, not every frame.
- **Demolitions explode** — a leaving building stays in the scene `BLAST_SEC` (2.6 s):
  `presence.blasts` gives its age, the building swells then vanishes, and `ReplayBlasts` draws a
  fireball, flying debris and smoke (three pooled instanced draws, `src/domain/blast.ts` for the
  pure, seeded trajectories). An island removed with its buildings sinks `BLAST_SINK_DELAY`
  after they blow up.
- **Director** — `planShots` (`src/domain/director.ts`) groups events into shots (wide intro →
  close-up per burst of events → wide outro) and `shotAt` interpolates them. Demolitions never
  share a shot with arrivals, and the camera holds on them through the blast (`BLAST_HOLD`). Untick
  **Director** in the bar to orbit freely.
- **Synthetic telemetry** — every service is healthy with a stable per-address request rate, so
  traffic flows on the roads. Automatic constructions count video time instead of wall time.

Code: `src/components/replay/`, `src/hooks/useReplayModel.ts`, `src/store/replayStore.ts`.

## MP4 export

`?capture=1` stops the rAF loop. The script drives the page frame by frame through
`window.__CITY_REPLAY__.frame(t, fps)`, which:

1. waits until React has committed the active set for `t` and every asset has loaded;
2. the first time (or after a jump), re-renders at a fixed time until the scene graph stops
   growing, then pre-rolls 2 s of simulation so traffic is already flowing;
3. calls R3F `advance(t)`: the scene clock *is* video time.

Two renders of the same range show the same scene: camera, buildings, traffic and lights all match.
Under SwiftShader a few pixels on silhouette edges still differ by a few levels (rasterizer
and AO noise, invisible).

```sh
bun scripts/render-replay.ts <scenario.json> [out.mp4|out.webm] \
  [--fps 30] [--from S] [--seconds N] [--width 1920 --height 1080] [--frames dir]
```

- `.mp4` needs `ffmpeg` on `PATH` (or `FFMPEG=…`): libx264, yuv420p, CRF 18.
- `.webm` falls back to Playwright's bundled ffmpeg (VP8) when none is installed.
- `--frames dir` also keeps every frame as an image.
- The page is served by `CITY_URL` (default the preview on `:4174`). It uses the same harness as
  the checks (`CHROMIUM_PATH`, `CITY_BACKEND`, `GPU_SOFTWARE`; see `render-performance.md`).
- Export defaults to `CITY_BACKEND=webgl`: headless screenshots of a WebGPU canvas come back blank.
- On a real GPU expect a few frames per second. SwiftShader (`GPU_SOFTWARE=1 CITY_BACKEND=webgl`)
  is far slower but works anywhere.

`window.__CITY_REPLAY__.seek(t)` pauses the interactive player at `t` (handy for screenshots).
