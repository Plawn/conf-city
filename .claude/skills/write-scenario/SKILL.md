---
name: write-scenario
description: Write or edit an "Infra Wrapped" replay scenario (public/scenarios/*.json) — the dated JSON that films the year's infrastructure as islands, buildings, roads and bridges appearing and exploding. Use when the user wants a replay video, a year-in-review / wrapped of their infra, or to add, date or remove servers, services or links in a scenario.
---

# Writing a replay scenario

A scenario is one JSON file holding **everything that existed over the period**, each piece
dated with `since` / `until`. The player turns it into a video: islands rise, buildings grow,
removed buildings explode, links become roads (same island) or bridges (between islands), and
a camera director frames each event. Full reference: `docs/replay.md`; types and validation:
`src/domain/scenario.ts` (`Scenario`, `parseScenario`).

## Workflow

1. **Gather the story.** Ask the user for the year's milestones if they have not given them:
   which servers (→ islands) and services (→ buildings) appeared, which were removed, which
   connections were made, with approximate dates. Months are enough.
   - Want the real infra as a base? Generate a skeleton where everything exists from 1 January,
     then date it by hand:
     ```sh
     bun scripts/scenario-from-snapshot.ts --year 2026 --out public/scenarios/2026.json            # live proxy
     bun scripts/scenario-from-snapshot.ts snapshot.json --year 2026 --out public/scenarios/2026.json
     ```
2. **Write** `public/scenarios/<name>.json` (start from `public/scenarios/example.json`).
3. **Check** — always, after every edit:
   ```sh
   bun scripts/check-scenario.ts public/scenarios/<name>.json
   ```
   It exits 1 with every error listed, or prints the timeline as the video plays it (video second,
   date, `+` arrival / `×` demolition) plus warnings. Fix all errors and read the warnings.
4. **Hand over** the commands to preview and export (give them in code blocks):
   ```sh
   bun run dev    # then open http://localhost:4000/?replay=/scenarios/<name>.json
   # or /?replay and « Open scenario… » to load any local JSON file
   bun run build && bun run preview --port 4174 &   # export reads this preview
   CHROMIUM_PATH=$HOME/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome \
     bun scripts/render-replay.ts public/scenarios/<name>.json out/replay/<name>.webm
   ```
   `.mp4` needs `ffmpeg` on `PATH`; `.webm` works without it.

## Format

```jsonc
{
  "title": "Infra Wrapped 2026",          // intro card (required)
  "subtitle": "What the platform team shipped this year",
  "start": "2026-01-01", "end": "2026-12-31",  // ISO dates, end after start
  "durationSec": 45,                       // video seconds between start and end (> 0)
  "minGapSec": 1.2,                        // slow motion: least seconds between event dates (default rampSec, 0 = off)
  "staggerSec": 0.6,                       // same-date buildings rise one after another (default rampSec / 2, 0 = together)
  "introSec": 3, "outroSec": 4,            // wide shots before / after (defaults)
  "rampSec": 1.2,                          // seconds a building rises or sinks
  "maxGapSec": 1.0,                        // time-lapse: a quiet stretch never takes more than this
  "chapterSec": 1.8,                       // the date holds this long on a chapter's title card
  "sunTime": "2026-06-21T17:30:00Z",       // frozen sun: late afternoon = warm light, long shadows
  "lang": "fr",                            // on-screen text and dates (default: the viewer's locale)
  "chapters": [                            // story beats: title card, then the events up to the next one
    { "at": "2026-02-01", "title": "Paris arrive", "caption": "API, Postgres", "stat": "+3 services" }
  ],
  "cities": [
    {
      "id": "paris-1", "name": "Paris",    // id: unique, stable, no "/"
      "biome": "harbour",                  // harbour | meadow | dunes | tundra | basalt
      "meta": { "label": "Paris", "cpuCores": 16, "memMb": 65536 },  // memMb sizes the island
      "since": "2026-02-01",               // optional; omitted = present from start
      "nodes": [
        { "id": "api", "type": "app", "label": "API", "ingress": true, "group": "core",
          "links": ["db", { "to": "cache", "since": "2026-03-10" }] },
        { "id": "db", "type": "db", "label": "Postgres", "group": "core" },
        { "id": "cache", "type": "cache", "label": "Redis", "since": "2026-03-01" },
        { "id": "legacy-db", "type": "db", "label": "MySQL", "until": "2026-07-01" }  // explodes
      ]
    },
    {
      "id": "azure", "name": "Azure",      // a managed service you call, not a machine you run
      "cloud": true,                       // floats above the sea; no memMb, no streets
      "nodes": [{ "id": "openai", "type": "app", "label": "Azure OpenAI", "building": "switchboard" }]
    }
  ],
  "links": [  // between islands → bridges; island ↔ cloud → cable car
    { "from": "paris-1/db", "to": "london-1/analytics-db", "since": "2026-08-10" }
  ]
}
```

- **Node `type`**: `app` | `db` | `cache` | `queue` — picks the building model.
- **`building`** (optional): a look in place of the type's default — `factory`, `legacy-shack`,
  `office-tower`, `storefront`, `workshop`, `watchtower`, `library`, `switchboard`, `relay-pylon`,
  `relay-station` (an external API, e.g. an LLM provider) for `app`; `silo`, `offshore-vault`
  (a managed external DB), `analytics-warehouse` for `db`; `kiosk` for `cache`. Any other value is
  accepted and drawn as the plain type.
- **`cloud: true`** (city): a managed cloud service (Azure, Groq, Scaleway…). It floats above the
  sea, its deck sized to its buildings (`meta.memMb` is ignored, the checker warns), comes down
  from the sky in the replay with a shot of its own, and links to it from an island become a
  cable car instead of a bridge. Links between two clouds are not drawn.
- **`ingress: true`**: the public entry point (gets a port gate). **`group`**: neighbourhood —
  same-group buildings sit together.
- **Node `links`**: ids of nodes **in the same city**, as a string or `{ "to", "since", "until" }`.
  Cross-city links go in the top-level `links` with `"city/node"` addresses.
- **Lifetimes are clipped**: a node never outlives its city, a link never outlives either end. So
  removing a city (`until`) blows up all its buildings, then the island sinks — no need to date
  each node.
- Ids must be unique (cities; nodes within a city), and every link must point at a known node.

- **`chapters`** (optional): each opens on `at` with a lower-third title card (`title`,
  `caption`, `stat`; `stat` omitted = computed from its events) and owns the events until the
  next chapter. 8–10 chapters tell a year; the checker warns above 12. The director frames one
  shot per chapter, the HUD shows a progress bar with a tick per chapter and a recap card in
  the outro (give `outroSec: 6` so the figures have time to count up).

## Making it look good

- **Start from the story, not the inventory.** A raw export of everything (hundreds of events)
  reads as a list. `bun scripts/condense-scenario.ts raw.json story.json --lang fr [--teaser]`
  merges churn, prunes short-lived services, pairs migrations, snaps bursts, writes the chapters
  and paces the video to a target length (`--target`, 100 s; teaser 60 s). Edit the chapter
  titles afterwards; re-run `check-scenario.ts`.

- **Space the events.** Video time follows dates at `durationSec / (end − start)`, except that
  slow motion keeps distinct event dates at least `minGapSec` apart (a demolition: its blast),
  so a busy week no longer pops at once; same-date events play as a cascade (island, then each
  building `staggerSec` apart, then demolitions) while the date on screen holds. Events less
  than ~2 video seconds apart share one camera shot
  (up to 6 per shot); a demolition always gets its own shot and a ~1.6 s hold for the blast. The
  checker prints "s per month" and flags simultaneous events — nudge dates by a few days to
  give each milestone its moment.
- **Size `durationSec` to the story**: about 2–3 s per distinct milestone. 15 milestones → 40–50 s.
  Quiet months are fine; the camera holds a wide shot.
- **Build in order**: a city first, then its database, then the services that link to it. A link
  appears only once both ends exist, so date links on or after their ends.
- **Show what the teams did**: migrations read well as "new building appears + link moves +
  old building explodes" a few days apart (e.g. `legacy-db` `until` just after the new `db`
  and its links arrive).
- **Vary biomes** between islands so each server is recognisable; give bigger machines a bigger
  `memMb` (it sizes the island — 8192 small, 65536 large).
- Labels are shown on screen: keep them short and human ("Postgres", "Billing API").
- Keep everything inside `start` → `end`; dates outside are warned about.
