# Rendering performance

The reference machine is an AMD Ryzen 5 7430U (6 cores / 12 threads), integrated
AMD Radeon Barcelo (`amdgpu`), approximately 16 GiB RAM, running Linux. The target
is 30 fps with the existing image quality. Resolution, AO, bloom, sunlight and
local-light budgets, shadow quality, traffic and animation timing are preserved.

## Changes

Opaque buildings are grouped by city, model primitive and 24-unit spatial tile.
Single buildings use ordinary draws with shared immutable geometry; repeated parts
use instancing. This keeps small batches cheap and distant regions independently culled.
GLTF transforms are baked into each batch's geometry; textures, normal maps and
vertex colors are retained. Each building owns its tint, emission, vertical scale
and interaction callbacks. Slots are compacted when a building disappears, and
capacity grows only when membership changes. Single-draw geometry is released only
after its last user; each instanced batch owns its attribute buffers. Bounds are refreshed after transform
changes and included in the sun's shadow fitting. Ports and transparent discovered
buildings retain individual rendering.

A single animation queue runs active building transitions and error pulses.
Unchanged, settled buildings and gauge colors sleep. Telemetry, hover, selection,
view mode and night-factor changes wake affected tasks. Fixed island, road and
bridge meshes no longer rebuild their local transform matrix every frame. Concurrent
R3F initialization requests share one renderer per canvas and recovery generation,
avoiding competing renderers with inconsistent framebuffer dimensions.
Replaced road, island, bridge and zone buffers are released during layout cleanup,
before another frame can reuse the render object with its new geometry. This avoids
Three r185's old-geometry disposal deleting the replacement's vertex buffers.

`?perf=1` exposes `buildingAnimationVisits` and `buildingInstanceWrites` alongside
the existing counters, and `shadows a+b/s`: sun and lighthouse shadow-map renders per
second (`sunShadowRenders`, `beaconShadowRenders`). Frozen lighting and unchanged
healthy telemetry should eventually produce zero for all of them; the sun map renders
at most `shadowHz` times per second during an orbit and about once a minute in live
time, never at night; the lighthouse map only at night. Continuous alerts
intentionally remain active.
The renderer reports its actual adapter in `__CITY_PERF__.adapter`, and the scene
inspection API includes building identities, colors, heights and screen positions.
These diagnostics do not run in normal use.

Batching trades additional instance/geometry buffers and coarser per-tile culling
for fewer draw calls. Frame-time gains depend on how much of the current workload
is building submission versus pixel shading. Measure zoomed views as well as the
whole world; reduced draw calls alone do not establish a GPU speedup.

## Quality tiers

Every per-frame budget that scales with the machine comes from one profile in
`src/domain/quality.ts`; components never carry their own constants for these.
`high` is the reference look, capped at 5 Mpx so a 4K or DPR 2 display does not
render four to eight times the pixels of a 1080p screen.

| | eco | balanced | high |
| --- | --- | --- | --- |
| Rendered pixels / render scale | ≤ 1.2 Mpx, ≤ 1× | ≤ 2.4 Mpx, ≤ 1.5× | ≤ 5 Mpx, ≤ 2× |
| Contact shading (GTAO) | off | 8 samples + denoise | 16 samples + denoise |
| Bloom mip chain | ¼ resolution | ½ resolution | ½ resolution |
| Sun shadow map / refresh ceiling | 1024² ≤ 4 Hz | 2048² ≤ 6 Hz | 2048² ≤ 6 Hz |
| Lighthouse shadow (refreshed at night, frozen by day) / volume | none / cone | 512² / raymarched | 512² / raymarched |
| Clustered points / vehicle headlight pairs (WebGPU) | 96 / 4 | 256 / 8 | 1024 / 16 |
| Cars / trucks | 120 / 30 | 240 / 60 | 240 / 60 |

The render scale is `min(devicePixelRatio, maxDpr, sqrt(maxPixels / canvas area))`,
quantised to 0.05 and never below 0.5. A 1080p screen at DPR 1 renders native in
`balanced` and `high` and at 0.75× in `eco`. Only a tier or layout change touches
it: ClusteredLighting rebuilds its buffers on resize, so interaction never does.

**Auto** (the default) starts from the adapter actually rendering: software or
fallback adapters and Intel on WebGL2 start in `eco`, Intel on WebGPU and unknown
adapters in `balanced`, discrete and Apple GPUs in `high`, one step lower with four
cores or fewer. A governor then measures frame intervals after each draw. It steps
down one tier when the p95 interval exceeds 1.25× the cadence budget (33 ms Office,
16.7 ms Smooth) for three seconds, and up one tier once the p95 holds within 1.05×
for thirty seconds, never above one tier over the starting point. Changes are at
least ten seconds apart, the two seconds after a change (recompilation, resize) are
discarded, intervals over 250 ms (tab switches, GC, debugger) and idle periods are
not evidence, and a step down within a minute of a step up lowers the ceiling so a
scene sitting on the boundary does not oscillate.

Auto also drops the cadence to 15 fps when the window loses focus or the pointer,
wheel, keyboard and touch have been quiet for two minutes, and returns to the mode's
cadence on the first event. A fixed tier keeps its cadence, so a wall display never
throttles. `?idle=0` disables the idle cadence for unattended benchmarks.

The status bar's display button opens Office/Smooth and Auto/Eco/Balanced/High; the
choice persists in `localStorage` (`conf-city-quality`). `?quality=eco|balanced|high|auto`
overrides it for one load so measurements can force a tier; the headless scripts
default to `high` (the previous fixed budgets) unless `CITY_PARAMS` names one. The HUD
prints the tier (`auto/balanced`, `eco`, `… (idle)`), and `__CITY_PERF__.quality`
exposes `{ choice, tier, idle, changes[] }` with every governor decision and its p95.

To qualify a machine, load `?perf=1&quality=eco`, then `balanced`, then `high`, note
fps, CPU ms, GPU ms and draws from the HUD, then load `?perf=1` alone and confirm
`__CITY_PERF__.quality.changes` converges on the same tier without oscillating.

## GPU costs inside the 3D pipeline

Open `?profile=1&quality=eco&idle=0` on the target machine, select Office (30 fps),
and let shaders and traffic warm up. In the **3D pipeline** panel, click **Record
10 s**. The panel shows average GPU milliseconds per sampled frame and the share
of each pass family: scene/materials/lighting, sun and lighthouse shadows (including
the `VSMVertical`/`VSMHorizontal` blur passes), clustered light compute, bloom,
contact shading, volume, composition and antialiasing.
Pass details remain available in the export. Repeat with a frozen day/night
preview and during camera motion, keeping the viewport and quality fixed.

**Export flamegraph** writes a Speedscope file. Open it in
<https://www.speedscope.app/> and choose **Left Heavy** for the aggregate cost tree.
Widths are measured GPU work, grouped by family and native pass name; they are
**not** absolute GPU timestamps, shader function call stacks or a chronological
timeline. The native per-pass GPU durations are counted once even when CPU render
submission calls are nested. **Export JSON** includes raw passes, CPU submission
scopes, complete-GPU-sample coverage, mean/p95 costs, adapter, resolution and the
quality/options at the start and export time. Intermittent shadows contribute zero
on complete frames where they did not run.

Only calls inside `LightingPipeline`'s composed draw are sampled. Simulation, DOM
work and environment baking outside that scope are excluded. Frames rendered while
an asynchronous readback is outstanding run normally without queries and are not
sampled; the report counts these skipped frames. Sampling and instrumentation can
affect the result, so use repeated captures and compare the ordinary HUD separately.
GPU utilization and power consumption cannot be inferred directly from these timings.
Queries are enabled only during a capture, with bounded sample and timestamp storage.
WebGL2 or devices without WebGPU timestamp support retain CPU scopes and report GPU
data as unavailable; they never substitute CPU durations. When combined with
`perf=1`, the profiler owns query resolution and the old HUD's GPU total is unavailable.

The scene pass includes water, geometry, materials and local light shading together.
To isolate their contributions, reload and compare one diagnostic switch at a time:

| Additional parameter | Work removed |
| --- | --- |
| `&localLights=0` | Real local lights (street lamps, vehicle spots, lighthouse projector); emissive geometry stays visible |
| `&shadows=0` | Sun and lighthouse shadow maps |
| `&bloom=0` | Bloom extraction, blur chain and bloom composition |
| `&ao=0` / `&volume=0` | Existing contact-shading / lighthouse-volume switches; already off in Eco |

These are comparisons within the current renderer, not a recreation of the old
pre-lighting renderer. Default visuals are unchanged. `window.__CITY_PROFILE__`
exposes `start(durationMs)`, `stop()`, `recording`, `resolving`, `report()` and
`speedscope()` in profile mode. Captures last 1–30 seconds and retain at most 1,800
sampled frames. Automated functional checks use `bun scripts/check-profile.ts`
(default URL `http://127.0.0.1:4175/`), with `CITY_URL`, `CITY_BACKEND`,
`CHROMIUM_PATH`, `CITY_OUTPUT` and `GPU_SOFTWARE=1` supported. Software GPU captures
validate attribution and export only, not performance on an integrated GPU.

### Tweaks

The Display popover in the status bar has a **Tweaks** section: one control per render
budget, on top of the selected tier, with a `· tweaked` label while any is active.
Tweaks persist in `localStorage` under `conf-city-tweaks`. `?tweaks=ao:0,bloomScale:0.25,volume:0`
wins at load and is not stored — an empty `?tweaks=` therefore loads clean. Booleans are
written `0` / `1`. Precedence:

| Layer | Effect |
| --- | --- |
| Quality tier | The baseline budgets, never edited |
| Tweaks | Raise or lower any single budget |
| URL kill-switches (`ao=0`, `bloom=0`, `volume=0`, `shadows=0`, `lights=N`, `localLights=0`) | Applied at the point of use; they only ever lower |

A/B recipe: fix the tier, load `?profile=1&quality=high&idle=0`, warm up, record a baseline,
change one tweak, wait for the shader compile hitch to pass, record again. The report carries
`startedWith.tweaks` / `startedWith.profile`; `changedDuringCapture` is `true` when a budget
moved mid-capture, which invalidates the samples.

What a tweak costs: AO samples, AO denoise, volume and bloom scale rebuild the whole node
pipeline (compile hitch); pixels, DPR, shadow map size and shadow Hz apply live; point lights
and vehicle spots rebuild the light pool; cars and trucks reset the traffic simulation.

Headless runs take the same grammar through the URL, e.g. `CITY_PARAMS="&tweaks=ao:0"`;
`check-profile.ts` and `check-lighting.ts` merge it before asserting which passes must run.
In `auto` quality the governor still steps the tier under tweaks, so pin a tier while measuring.


## Reproducible comparison

Build and serve the application, then run browser measurements sequentially:

```sh
bun run build
bun run preview --host 127.0.0.1 --port 4174 --strictPort
# Separate terminal, same browser, viewport, DPR and power conditions before/after:
CITY_OUTPUT=out/benchmark/after bun scripts/benchmark-rendering.ts
CITY_BACKEND=webgl CITY_OUTPUT=out/benchmark/after-webgl bun scripts/benchmark-rendering.ts
# A fixed exported world, then a larger version with repeated services per city:
CITY_WORLD=/path/to/world.json CITY_OUTPUT=out/benchmark/world bun scripts/benchmark-rendering.ts
CITY_WORLD=/path/to/world.json CITY_WORLD_SCALE=10 CITY_OUTPUT=out/benchmark/large bun scripts/benchmark-rendering.ts
```

The runner defaults to three repetitions, Office / 30 fps, and 30 seconds per
lighting/camera scenario after warmup. `CITY_RUNS`, `CITY_DURATION_MS`, `CITY_CASE`,
`CITY_WIDTH`, `CITY_HEIGHT`, `CITY_DPR`, `CITY_URL` and `CHROMIUM_PATH` customize the
run. Existing defaults are 960×600 at DPR 1; use the target browser's dimensions
for qualification. Without `CITY_WORLD`, the repository sample is the reference.
Each report directory records the world; the runner also records CPU and RAM.

`CITY_RENDER_MODE=office|smooth` works in both existing scripts. Reports retain
the original 18 ms statistics and add `frameBudgetMs` / `framesOverBudgetPct`:
35 ms in Office, 18 ms in Smooth. The runner enables `CITY_ASSERT_BUDGET=1`, which
requires a verified hardware adapter and rejects a p95 over that budget. Set it
to `0` when recording a slow baseline. GPU timestamps remain asynchronous and may
be unavailable; they are not replaced with CPU timings.

## Functional checks

```sh
bun test
bun run lint
bun run build
bun scripts/check-buildings.ts
CITY_BACKEND=webgl bun scripts/check-buildings.ts
CITY_TRANSITIONS=1 CITY_LIFECYCLE=1 CITY_RECOVERY=1 CITY_CASE=night bun scripts/check-lighting.ts
bun scripts/check-camera.ts
CITY_BACKEND=webgl bun scripts/check-camera.ts
```

`check-buildings.ts` exercises sleeping animations, real pointer selection,
telemetry-driven height and fire, heatmaps, transition to a transparent discovered
building, conversion into a port, and restoration. It writes captures and a report.
Unit tests cover slot growth/removal, nested transforms, texture ownership, bounds,
animation wakeup, error pulses, spatial culling, shared geometry lifetime, concurrent
renderer initialization and frame-budget summaries.

`GPU_SOFTWARE=1` selects SwiftShader for functional checks, never hardware
qualification. Without it the scripts launch Chromium with the flags from
`scripts/chromium-args.ts` (`--use-angle=vulkan --enable-features=Vulkan
--disable-vulkan-surface`): on Linux, headless Chromium silently falls back to
SwiftShader on both backends without them. The account running the scripts must be
able to open `/dev/dri/renderD128` (member of the `render` group, or a temporary
`setfacl -m u:<user>:rw` on the device); `__CITY_PERF__.adapter` in the report says
which device actually rendered. On the reference machine Dawn reports the Radeon
Barcelo as `amd` / `rdna-2`, so the Auto tier starts at `high` in WebGPU.

The capture helper removes WebGPU's 256-byte row padding, allowing comparison at
arbitrary viewport widths, including 800 pixels.

## Local measurements

A before/after run on 2026-09-06 used Chromium 149.0.7827.55, WebGPU with
SwiftShader, 640×400 at DPR 1, Office mode, a frozen noon preview and the sample
world expanded to 100 nodes in its two cities. Each run recorded 30 frames.
Both reports contain zero browser errors.

| Median per frame | Before | After |
| --- | ---: | ---: |
| Draw calls | 235 | 196 (−16.6%) |
| Triangles | 293,870 | 293,870 |
| Renderer allocation counter | 74.68 MB | 77.36 MB (+3.6%) |
| CPU submission time | 9.85 ms | 9.25 ms |

The final settled frame has zero building animation visits and zero building
writes. Allocation counters describe renderer-tracked resources, not total process
memory. CPU timings from a single software-rendered run are too noisy to establish
a speedup; hardware frame time and the 30 fps target remain unqualified.
Raw reports, samples, worlds and captures are in the ignored local directories
`out/optimization/large/before` and `out/optimization/large/after`.

### Fast shadows (2026-09-11)

Measured headless on the Radeon Barcelo (WebGPU, Vulkan through ANGLE), Chromium
1228, 1280×800 at DPR 1, `quality=high`, `idle=0`, the production world of three
cities (26 nodes, 12 bridges) framed with fit-all, a frozen 14:00 or 01:00 preview
and a 10 s capture. Medians over four captures each; GPU times come from the
pipeline profiler, frame times from the `?perf=1` samples. Zero browser errors.

| Median | Before noon | After noon | Before night | After night |
| --- | ---: | ---: | ---: | ---: |
| GPU per frame | 17.2 ms | 14.3 ms | 17.3 ms | 17.4 ms |
| Scene / materials / lighting | 8.5 ms | 4.6 ms | 8.6 ms | 8.7 ms |
| Composition / antialiasing | 3.6 ms | 4.0 ms | 3.6 ms | 3.7 ms |
| Bloom | 3.3 ms | 3.5 ms | 3.3 ms | 3.3 ms |
| Contact shading | 1.3 ms | 1.7 ms | 1.3 ms | 1.3 ms |
| Frame interval p95 | 32.9 ms | 19.6 ms | 32.6 ms | 33.4 ms |
| Draw calls | 167 | 112 | 118 | 119 |
| Sun map renders per 10 s | n/a | 0 | n/a | 0 |
| Lighthouse map renders per 10 s | n/a | 0 | n/a | 130 |

By day the scene pass halves: the sixteen vehicle spots leave the shader, the sun
map is no longer redrawn and vehicles no longer cast into it (55 draws fewer), and
each fragment reads one VSM texel instead of five compares. At night nothing moved
because the cost sits in the local lights themselves, not in their shadows:
`localLights=0` brings the night scene pass to 3.4 ms on both builds while
`shadows=0` changes nothing. The next lever for the night was the per-fragment
evaluation of the vehicle spots, which the clustered node of three r185 left to the
material path; see the clustered headlights section below.
Contact shading stays around 10 % of the frame, so the half-resolution denoise
remains unimplemented. Raw rows, the matrix script and the world are in
`out/profile/fast-shadows`.

### Clustered headlights (2026-09-11)

Same rig, world and captures as above, three alternated runs per build against the
Tweaks commit (`0c8094e`), night preview only. `ClusteredLightsNode` of three r185
only clusters shadowless point lights, so every vehicle spot was evaluated on every
fragment. The TS fork in `lighting/clustered/` packs opted-in spots (`userData.clustered`,
no shadow map) into the same data texture with a cone bounding sphere for the compute
test and a `smoothstep` cone factor in the fragment loop; point lights carry sentinel
cone cosines so both kinds share one shading path. Each vehicle slot owns a headlight
pair that splits within 12 units of the camera and merges beyond 16, the merged
second spot sitting at intensity 0 and compacted away before packing.

| Median, night | Before | After | `localLights=0` |
| --- | ---: | ---: | ---: |
| GPU per frame | 17.1 ms | 12.1 ms | 11.6 ms |
| Scene / materials / lighting | 8.41 ms | 3.74 ms | 3.34 ms |
| Light clustering | 0.43 ms | 0.47 ms | 0.47 ms |
| Frame interval p95 | 33.4 ms | 17.7 ms | 17.6 ms |
| CPU p95 | 7.1 ms | 4.7 ms | 3.8 ms |
| Draw calls | 120 | 121 | 112 |

The night scene pass now sits 0.4 ms above the no-local-lights floor, and the
night frame interval matches the daytime one. Composition, bloom and contact
shading are unchanged. The spots left the material light list, so dusk and dawn
no longer recompile materials: the night camera check reports zero pipeline
compiles in motion, `check-lighting` passes on both backends and the night profile
check shows the `Light clustering` group with spot visits above zero. Rows and the
matrix script are in `out/profile/b-night` and the session scratchpad.

Final validation passed 221 unit tests, lint, application and benchmark-script type
checks, and the production build. Browser checks at 800×500 passed building
interactions and world replacement with 100 nodes on both backends, plus noon/night
camera movement with zero resizes or new shader/pipeline compilations. WebGPU also
passed day/night transitions, two city hide/show cycles and simulated device-loss
recovery. All five browser reports in `out/optimization/final` contain zero errors.
