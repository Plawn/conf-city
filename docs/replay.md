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
| `start`, `end` | ISO dates bounding the timeline (mapped onto `durationSec`, slowed where busy) |
| `durationSec` | Video seconds between `start` and `end` at the base pace |
| `minGapSec` | Least video seconds between two distinct event dates (default `rampSec`, 0 = linear) |
| `staggerSec` | Seconds between buildings arriving on the same date (default `rampSec / 2`, 0 = together) |
| `introSec` / `outroSec` | Wide shot before / after (default 3 / 4) |
| `maxGapSec` | Time-lapse: a quiet stretch between two event dates never takes more than this (default none = base pace) |
| `rampSec` | Seconds a building takes to rise or sink (default 1.2) |
| `sunTime` | ISO instant the sun is frozen at |
| `lang` | BCP 47 tag of the on-screen text and dates (`"fr"`); default the viewer's locale |
| `chapters[]` | Story beats: `{ "at", "title", "caption"?, "stat"? }` — opens on `at` with a title card, owns the events up to the next chapter |
| `chapterSec` | Seconds the date holds on a chapter's opening while its title card shows (default 1.8) |
| `cities[]` | `id`, `name`, `biome`, `meta` (`CityMeta`: `memMb` sizes the island), `nodes[]` |
| `cities[].nodes[]` | `GraphNode` fields; `links` items are a node id or `{ "to", "since", "until" }` |
| `cities[].nodes[].building` | Look (`BUILDING_KINDS`): `factory`, `legacy-shack`, `office-tower`, `storefront`, `workshop`, `watchtower`, `library`, `switchboard`, `relay-pylon`, `relay-station` (app), `silo`, `offshore-vault`, `analytics-warehouse` (db), `kiosk` (cache); unknown or other-type kinds draw the type's models |
| `links[]` | Inter-city links `{ "from": "city/node", "to": "city/node" }` → bridges |

A chapter's events start after its hold, so a building dated the same day rises once the card
is gone. Chapters are optional, but a raw year (hundreds of events) is unwatchable without
them: `bun scripts/condense-scenario.ts` writes a story-shaped scenario from one (below).

Every city, node and link takes optional `since` / `until` (ISO dates; omitted = from the start /
until the end). Lifetimes are clipped: a node never outlives its city, a link never outlives
either end. `parseScenario` lists every problem at once.

Check a scenario (errors, the timeline as the video plays it, warnings such as simultaneous
events) with `bun scripts/check-scenario.ts <file.json>`. The Claude skill
`.claude/skills/write-scenario` writes and dates scenarios with it.

A skeleton from today's infrastructure (everything present from 1 January), then date by hand:

```sh
bun scripts/scenario-from-snapshot.ts                       # live proxy (ws://localhost:4001/ws/frontend)
bun scripts/scenario-from-snapshot.ts snapshot.json --year 2026 --out public/scenarios/2026.json
```

## Condensing a raw scenario

A scenario generated from git history is a full year of commits. `condense-scenario` turns it into a story.

```sh
bun scripts/condense-scenario.ts raw.json full.json --lang fr            # ~100 s
bun scripts/condense-scenario.ts raw.json teaser.json --lang fr --teaser # ~60 s
bun scripts/check-scenario.ts full.json && bun scripts/check-shots.ts full.json
```

The tool is pure (`src/domain/scenarioCondense.ts`, plus `…Core.ts` and `…Chapters.ts`) and deterministic. Unknown node fields such as `building` are kept. It prints a report:

- events before and after, both with links and as city/service beats only;
- clouds, churn merges, staging folds, prunes and cuts;
- moves, grouped by (from, to, date);
- each chapter with its date, its length in seconds, its title and its stat;
- the solved `durationSec` and `maxGapSec`, and the total length.

Rules, in the order they run (defaults in brackets):

| # | Rule | Option |
|---|---|---|
| 1 | Clouds. A city whose services all use an external look (`relay-station`, `offshore-vault`) becomes `cloud: true`, and its `meta.memMb` is dropped. | `--cloud id,id` |
| 2 | Churn. A service removed and then re-added under the same id or label (parentheticals ignored) is one lifetime. Skipped when the id reappears on another island within `moveDays`. Staging twins fold into production (`--keep-staging` disables this). | `--churn-days` [30] |
| 3 | Prune. Services alive less than `minDays` are removed, with their links; cities left empty go too. Migration ends are kept. | `--min-days` [14] |
| 4 | Migrations. A service leaving island A and rising on island B is matched by id, then by label, within ±`moveDays`. The old service's `until` is set to the new one's `since`. | `--move-days` [14] |
| 5 | Snap. Bursts on one island snap to their first date within `snapDays`, and same-stack arrivals within `stackDays`. Stack = id prefix before the first `.`, else group, else id. Removals snap the same way. Arrivals within `openDays` of `start` join the starting point. Then dates snap across islands, but island arrival dates never move. Links whose span is empty are dropped. | `--snap-days` [4], `--stack-days` [10], `--open-days` [14] |
| 6 | Cap. Protected: islands, clouds, migrations, ingress, db, services there all along, arrivals that share an island's date, and for every cloud the island end of its longest-lived link (so each cloud keeps a cable car). The rest drop stack by stack until the city/service beats fit: legacy stacks first (there from the start, only torn down), then the smallest. | `--max-events` [130], `--top-stacks` |
| 7 | Chapters. Candidates are scored: opening > island arrival > migration of ≥ 5 services > cloud arrival > busiest date. They are taken greedily, at least `chapterDays` apart, and the stronger candidate absorbs the weaker one's services. Titles come from fr/en templates (≤ 32 characters). `--lang` also sets the scenario's `lang`. | `--chapters` [9], `--chapter-days` [10] |
| 8 | Pacing. Fixed values: `minGapSec` 0.8, `staggerSec` 0.25, `chapterSec` 1.8, `introSec` 3, `outroSec` 6. `durationSec` is bisected until the total lands within 2 s of the target. When the time-lapse cap saturates, `maxGapSec` is raised instead. Several `maxGapSec` and `chapterSec` steps are tried, and the first one in which every chapter lasts at least `minChapterSec` wins. A chapter that is still too short merges with its neighbour when either one is an island arrival ("Groq et Worker-1"), and is dropped otherwise. | `--target` [100], `--max-gap` [1], `--chapter-sec`, `--min-chapter-sec` [6] |

`--teaser` changes these defaults: target 60 s, 7 chapters, 70 beats, the top 6 stacks. It also stops protecting services that are there all along and arrivals sharing an island's date. It keeps only migrations in groups of 5 or more.

`--max-events` counts city and service events. Links rise and fall with their ends and cost no screen time, so they are not counted. `check-scenario` counts every event.

## How it works

- **Frozen layout** — `planWorld` lays out the union of the whole year once; `assembleWorld(plan,
  active)` rebuilds roads, gates and bridges for the pieces alive at an instant, reusing the
  union's positions and utility plots. Nothing moves when a city grows, and the exact-equality
  invariant holds (`tests/layout/pinnedLayout.test.ts`).
- **Slow motion** — dates map to video time through `tl.clock` (`src/domain/replayClock.ts`),
  piecewise linear: two distinct event dates sit at least `minGapSec` apart (`BLAST_SEC` after
  a demolition), so a busy week plays out one step at a time and the date on screen slows down.
  Events on the **same date** play as a cascade while the date holds: islands, then each
  building `staggerSec` after the previous one (its roads rise with it), then demolitions
  `minGapSec` later — a migration reads as "the new one rises, the old one blows up". Quiet
  months keep the base pace; the video grows by the time added (the checker prints it).
- **Everything is a function of video time `t`** — `presenceAt(timeline, t)` gives each entity a
  presence in [0, 1] with eased ramps. Buildings scale up from the ground, islands rise from
  the sea and cloud services come down from the sky (`RisingCity`, offset by `cityLift` in
  `src/domain/replayLift.ts`, shared with the blasts), and leaving links and islands sink. A
  cable car is strung once both its island and its cloud have settled. `activeKey(presence)` only changes
  at an event, so React reassembles the world at events, not every frame.
- **Demolitions explode** — a leaving building stays in the scene `BLAST_SEC` (2.6 s):
  `presence.blasts` gives its age, the building swells then vanishes, and `ReplayBlasts` draws a
  fireball, flying debris and smoke (three pooled instanced draws, `src/domain/blast.ts` for the
  pure, seeded trajectories). An island removed with its buildings sinks `BLAST_SINK_DELAY`
  after they blow up.
- **Director** — `planShots` (`src/domain/director.ts`) plans few, slow, purposeful moves; `shotAt`
  interpolates them. With chapters, one framing per chapter, landing on its title card
  (`chapter.at`, slipping at most `holdSec`), so the camera travels during the previous chapter's
  tail, never during the rises. It frames the cities carrying the bulk of the chapter's buildings
  (a lone side job stays off frame; an island arriving weighs more); a chapter opening on a cloud
  is framed at its altitude with the nearest cable-car mast (with no cable car, the nearest
  island standing, never empty sea). A demolition in a city where nothing
  rises gets one aside framing both cities, folded into the chapter's framing when too close.
  Without chapters, bursts of events get a shot each; demolitions are held through the blast
  (`BLAST_HOLD`) and catch the next burst under way rather than cut short. Everywhere, a framing
  holds at least `MIN_HOLD` (4 s) before the next move: a move that cannot fit merges into its
  neighbour, the lighter burst giving way so the heavier lands on time (the intro wide alone may
  hold less). Holds stay alive: a slow push-in (`DRIFT`) and an orbit of `ORBIT_DEG_PER_SEC`
  (1.3°/s, easing toward 45° per shot: ≤ 12° in 10 s). A wide shot only fills a quiet stretch
  longer than `WIDE_GAP` (time-lapse seconds excluded) that can hold it ≥ 4 s; intro and outro
  wides stay. `bun scripts/check-shots.ts <scenario.json>` prints every shot and the totals (shot
  count, moving %, holds). Untick **Director** in the bar to orbit freely.
- **Synthetic telemetry** — every service is healthy with a stable per-address request rate, so
  traffic flows on the roads. Automatic constructions count video time instead of wall time.

Code: `src/components/replay/`, `src/hooks/useReplayModel.ts`, `src/store/replayStore.ts`.

## On-screen narration

Everything below is a pure function of video time (`src/domain/replayStats.ts`), so an exported
frame matches playback.

- **Chapter title cards** — lower third, left-aligned: "03 / 09", the chapter `title`, its
  `caption`, and a stat chip. The card fades in over 0.35 s from the chapter's opening, holds
  through `chapterSec` (the date stands still meanwhile) and fades out over 0.5 s as the first
  building rises. The chip shows `stat` when given, else what the chapter's events did:
  `+1 island`, `+1 cloud`, `+N services`, `N moved` (a service removed in one city and added in
  another, same id or label, within 31 days), `N demolished`.
- **Progress bar** — a segmented bar along the bottom edge (intro, one segment per chapter,
  outro), filled to `t`; the current chapter's title sits above its segment, hidden while its
  card shows.
- **Corner HUD** — month, servers, clouds and services. While the date leaps (a `maxGapSec`
  stretch running over 4× the date's mean pace) the month changes without sliding and a ⏩
  fades in.
- **Recap** — from the outro's start, the scenario title over six figures: four non-zero counts
  among services deployed over the period (not only those still standing), islands,
  clouds, bridges, moved and demolitions, then the longest-lived
  service still standing (days) and the busiest month (events). It fades in over 0.6 s and each
  figure counts up over 1.2 s, 0.15 s after the previous one: settled 2.3 s into the outro.
- **`lang`** — `Intl` formats (month, numbers) use the scenario's `lang` (default the viewer's
  locale); the HUD and recap words are English, or French when `lang` starts with `fr`.

In the interactive player, chapter dots above the scrub bar jump to a chapter.

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
  [--fps 30] [--from S] [--seconds N] [--width 1920 --height 1080] [--workers 3] [--frames dir]
```

- `.mp4` needs `ffmpeg` on `PATH` (or `FFMPEG=…`): libx264, yuv420p, CRF 18.
- `.webm` falls back to Playwright's bundled ffmpeg (VP8) when none is installed.
- `--workers N` (default 3) renders N contiguous slices in parallel Chromiums, then joins them
  without re-encoding. Each slice pre-rolls on its own, so joints are invisible. Beyond 3 the
  Radeon box saturates: the full wrapped replay (6 062 frames, 1080p) takes 12 min, against 56.
- Frames are JPEG screenshots (quality 95): a quarter of a PNG's cost, invisible after x264.
- About 8 % of frames, where the active set changes, remount and compile shaders: up to 2.6 s
  each, two thirds of the render time. A steady frame takes ~43 ms.
- `--frames dir` also keeps every frame as an image (forces one worker).
- The page is served by `CITY_URL` (default the preview on `:4174`). It uses the same harness as
  the checks (`CHROMIUM_PATH`, `CITY_BACKEND`, `GPU_SOFTWARE`; see `render-performance.md`).
- Export defaults to `CITY_BACKEND=webgl`: headless screenshots of a WebGPU canvas come back blank.
- On a real GPU expect ~8 frames per second with 3 workers. SwiftShader (`GPU_SOFTWARE=1 CITY_BACKEND=webgl`)
  is far slower but works anywhere.

`window.__CITY_REPLAY__.seek(t)` pauses the interactive player at `t` (handy for screenshots).
