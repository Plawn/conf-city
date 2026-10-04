# Rendering performance

The reference machine is an AMD Ryzen 5 7430U (6 cores / 12 threads), integrated
AMD Radeon Barcelo (`amdgpu`), approximately 16 GiB RAM, running Linux. The target
is 30 fps with the existing image quality. Resolution, AO, bloom, sunlight and
local-light budgets, shadow quality, traffic and animation timing are preserved.
The bloom storage optimization described below reduces intermediate color
precision; it is explicitly recorded as a tradeoff, not a lossless change.

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

The scene writes normal and emissive attachments only when an enabled effect
reads them: Eco and `ao=0` omit both, while experimental SSGI retains normals.
Empty clustered-light lists skip GPU compute and the fragment loop; a render-group
count uniform prevents reading stale indices, including across the nested volume
pass, resizes and day/night changes. Non-empty lists resume compute immediately.
The Canvas starts with the selected pixel budget rather than first allocating
targets at R3F's default DPR. These changes preserve the selected quality profile.

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
WebGL2 measures whole-pipeline elapsed GPU time when
`EXT_disjoint_timer_query_webgl2` is available. Its per-pass GPU fields stay null;
the elapsed mean/p95/sample count are separate fields. Disjoint, expired and
unsupported queries remain null, never zero or a reused previous result. One query
can be outstanding; availability is polled without `finish()` or a synchronous wait.
This elapsed scope differs from WebGPU's exclusive pass sums, so it cannot establish
a direct GPU speedup percentage between backends. Devices without GPU timers retain
CPU scopes only; they never substitute CPU durations. When combined with
`perf=1`, the profiler owns query resolution and the old HUD's GPU total is unavailable.

The scene pass includes water, geometry, materials and local light shading together.
To isolate their contributions, reload and compare one diagnostic switch at a time:

| Additional parameter | Work removed |
| --- | --- |
| `&localLights=0` | Real local lights (street lamps, vehicle spots, lighthouse projector); emissive geometry stays visible |
| `&shadows=0` | Sun and lighthouse shadow maps |
| `&bloom=0` | Bloom extraction, blur chain and bloom composition |
| `&bloom=reference` | Diagnostic reference: native RGBA16F bloom storage |
| `&ao=0` / `&volume=0` | Existing contact-shading / lighthouse-volume switches; already off in Eco |
| `&water=0` | Water mesh and its shading (diagnostic only) |
| `&antialias=0` | FXAA and its intermediate sRGB target; tone mapping still runs in the final draw (diagnostic only) |

These are comparisons within the current renderer, not a recreation of the old
pre-lighting renderer. `window.__CITY_PROFILE__`
exposes `start(durationMs)`, `stop()`, `recording`, `resolving`, `report()` and
`speedscope()` in profile mode. Captures last 1–30 seconds and retain at most 1,800
sampled frames. Automated functional checks use `bun scripts/check-profile.ts`
(default URL `http://127.0.0.1:4174/`), with `CITY_URL`, `CITY_BACKEND`,
`CHROMIUM_PATH`, `CITY_OUTPUT` and `GPU_SOFTWARE=1` supported. Software GPU captures
validate attribution and export only, not performance on an integrated GPU.

### Automated GPU pipeline benchmark

`bun run bench:pipeline` records each native GPU pass on the actual adapter, then
ablates one effect at a time. Defaults: the repository sample, WebGPU, 1280×800 at
DPR 1, Office (30 fps), High, frozen noon and night, a stationary fit-all camera,
three repetitions of ten seconds after warmup. Each repetition rotates the variant
order. Telemetry is the shared healthy fixture, not a replay of live production
metrics or incidents. Each capture uses a fresh browser context, so persistent
construction and user tweaks cannot change the workload between variants.
Host metrics are supplied for every city (35% CPU, 37.5% RAM, 40% disk).
Camera/lighting URL-hash edits keep telemetry active; only document navigation
resets a custom world until its JSON is loaded. An enabled WebGPU lighthouse
volume must actually run during the night baseline or the runner rejects it.

```sh
bun run build
bun run preview --host 127.0.0.1 --port 4174 --strictPort
# Separate terminal; optionally set CHROMIUM_PATH to the installed Chromium executable:
bun run bench:pipeline
# Use an exported production world and keep every parameter fixed for future comparisons:
CITY_WORLD=/path/to/world.json CITY_OUTPUT=out/pipeline/baseline bun run bench:pipeline
# Smaller selection for a targeted experiment (baseline is always included):
CITY_VARIANTS=no-water,no-fxaa CITY_CASE=night CITY_OUTPUT=out/pipeline/targeted bun run bench:pipeline
```

The runner writes `summary.md`, `summary.json`, `rows.json`, the world, raw per-pass
captures, and first-run PNGs/Speedscope exports into `out/benchmark-pipeline` (or
`CITY_OUTPUT`). Raw JSON records the actual render resolution, budgets, adapter,
camera, sampling coverage, CPU submission/frame intervals, draw calls and renderer
allocation counters. Summary totals are medians of per-run GPU means; ranges are
observed run means, not confidence intervals. Pass-family shares use equally
weighted run means. Each ablation's saving is paired with the same repetition's
baseline; retain negative deltas rather than claiming every removal is a gain.
Savings are not additive: changing water or an effect can alter other passes.
GPU milliseconds are not GPU utilization or power consumption.

`CITY_RUNS`, `CITY_DURATION_MS` (1–30 s), `CITY_WARMUP_MS`, `CITY_CONTROL_MS`, `CITY_CASE`,
`CITY_WIDTH`, `CITY_HEIGHT`, `CITY_DPR`, `CITY_RENDER_MODE`, `CITY_BACKEND`,
`CITY_PARAMS`, `CITY_WORLD` and `CITY_WORLD_SCALE` customize the reference.
The runner clears persisted tweaks unless `CITY_PARAMS` explicitly supplies them.
Software fallback adapters are rejected unless `GPU_SOFTWARE=1` explicitly requests
functional validation. WebGL2 retains CPU observations and reports a separate
whole-pipeline GPU elapsed measurement when its timer extension is available.
Captures with browser errors, changed budgets or fewer than ten
complete WebGPU hardware samples fail, preserving their raw report for diagnosis.

### Pipeline cost baseline (2026-10-04)

Measured on the Ryzen 5 7430U / AMD hardware adapter with Chromium 149.0.7827.55,
WebGPU, the local production-world export (3 cities, 26 services), 1280×800 at DPR 1,
Office / 30 fps, High, no tweaks, a stationary fit-all view and frozen noon/night.
The renderer includes the conditional MRT and empty-cluster cleanups described above.
The healthy fixture supplies host metrics to every city and keeps reporting after
camera/lighting hash edits. Night captures contain three active beacons, traffic
and one selected volumetric projector. Each scenario ran three times for five
seconds after setup and three seconds of warmup; 48 captures contain 7,197 complete
GPU samples (149–150 per capture), with zero browser errors.

| GPU pass family (mean across repetitions) | Day ms | Night ms |
| --- | ---: | ---: |
| Scene / materials / lighting, including water and shadow lookups | 3.77 | 3.84 |
| Bloom | 2.66 | 2.69 |
| Contact shading (AO + denoise) | 2.26 | 2.21 |
| Composition / antialiasing | 1.98 | 1.96 |
| Lighthouse volume | 0 | 1.07 |
| Light clustering | 0 | 0.51 |
| Shadow-map renders / VSM blur | 0 | 0.04 |

Median total GPU time is **10.76 ms by day / 12.35 ms at night**. These medians
need not equal the sum of the equally weighted pass means above. Baseline GPU p95
medians are 11.61 / 13.22 ms. CPU update/submission averages are approximately
3.9 / 4.9 ms; the frame cadence remains around 30 fps.

| Effect removed (median paired saving) | Day ms | Night ms |
| --- | ---: | ---: |
| Water | 3.09 | 2.98 |
| AO | 2.75 | 2.45 |
| Bloom | 2.42 | 2.41 |
| All local lighting, including the selected volume | 0.60 | 2.42 |
| Lighthouse volume, replaced by its fallback cone | 0.30 | 1.25 |
| Shadows | 0.39 | 0.26 |
| FXAA and its intermediate target | 0.16 | 0.21 |

Prioritise the water shader, bloom and AO. Their removal measurements are upper
bounds for optimisations that preserve the image, not promised gains. Removing
AO also removes its normal/emissive attachments, so its saving exceeds the AO-pass
duration alone. Removing local lighting also removes the volume: do not add those
savings. Shadow-map caching already makes map renders cheap in this stationary
view; moving-camera shadows need a separate benchmark. The composition family
includes tone mapping and effect composition that still run without FXAA, so
disabling FXAA saves far less than that family's total cost. Volume and local
lighting remain secondary night targets, with a separate closeup required for the
beam. A useful next controlled comparison is quarter-resolution bloom via
`CITY_PARAMS='&tweaks=bloomScale:0.25'`, and lower AO samples, retaining screenshots
to assess the visual tradeoff.

Raw reports, PNGs, Speedscope exports, the world, adapter/settings and loaded build
asset hash are in the ignored local directory `out/pipeline/reference-2026-10-04`.
The baseline build is `index-CozDt9c7.js`. Replay this exact reference against a
production preview (set `CITY_URL` / `CHROMIUM_PATH` if necessary):

```sh
CITY_WORLD=out/pipeline/reference-2026-10-04/world.json \
CITY_RUNS=3 CITY_DURATION_MS=5000 CITY_WARMUP_MS=3000 \
CITY_OUTPUT=out/pipeline/next bun run bench:pipeline
```

These timings describe the 3D composed draw at this viewport, with healthy synthetic
telemetry. They exclude simulation, DOM/compositor work and environment baking
outside the pipeline, and do not establish an operating-system GPU percentage or
power saving. The report retains run ranges; small deltas and noisier variants
require targeted repetition before changing defaults.

### Bloom optimization: storage and precision (2026-10-04)

**Classification: pipeline bandwidth improvement with a precision tradeoff.**
This is not a lossless change. On WebGPU devices supporting
`rg11b10ufloat-renderable`, the eleven bloom targets use positive RGB R11G11B10F
(4 bytes/texel) instead of RGBA16F (8 bytes/texel). Bloom consumes RGB only; its
alpha channel was unused. HDR range is retained, but RGB mantissa precision is
lower, especially blue. WebGL and unsupported WebGPU devices keep native RGBA16F.
`bloom=reference` restores native storage for diagnosis.

The native Three bloom algorithm remains intact: extraction, five mip levels,
twelve passes, resolution scale, Gaussian kernels, strength 0.25, radius 0.3 and
threshold 1.15. No quality tier, effect or sampling budget is lowered. The compact
node changes only target formats, through Three r185's private target fields;
revalidate it after Three upgrades. Output composition is factored into one helper
shared by normal rendering and explicit visual reference captures.

Four alternating repetitions on the same AMD hardware adapter, Chromium 149,
WebGPU, High, Office/30 fps, 1280×800 DPR 1, 3 cities / 26 services, frozen noon/night,
fit-all, healthy telemetry, 5 s measurement and 3 s warmup after setup:

| Measurement (median run means) | Native RGBA16F | Compact RGB | Reduction |
| --- | ---: | ---: | ---: |
| Day bloom | 2.55 ms | 1.42 ms | 44% |
| Night bloom | 2.72 ms | 1.62 ms | 40% |
| Day composed pipeline | 10.37 ms | 9.33 ms | 10% |
| Night composed pipeline | 12.47 ms | 11.49 ms | 8% |

Median paired whole-pipeline savings are 1.10 ms by day and 0.94 ms at night.
Raw reports retain variability, including a 14.07 ms native night run rather than
discarding it. At this resolution, bloom targets alone shrink from approximately
7.16 to 3.58 MiB. This does not halve total renderer memory or establish an OS GPU
utilization/power reduction. Reports are in `out/bloom/compact-gpu`, build
`index-B811f9Sw.js`; `baseline` means optimized and `bloom-reference` means native,
so the automated ablation table reports negative savings for the native variant.

Visual comparisons use two separate bloom nodes reading the **same scene textures
in the same simulation frame**. Four synchronous draws queue native/native-control
and optimized/optimized-control before yielding to animation. Both controls must
be bit-identical, or the comparison is rejected. Metrics cover final 8-bit sRGB
RGB values after tone mapping and FXAA; a low global average alone does not prove
that bright details are unchanged. Numerical tolerances are indicators, not a
perceptual guarantee.

Day, dawn and night are checked in fit-all and beacon closeup views. Night has
localized differences near lights; both the mean and the worst pixel are retained.
Do not describe these as zero visual loss. `check:bloom` exports the original PNGs,
differences amplified ×16, `report.json` and an interactive `review.html` slider.
The reference node and its output targets exist only with `bloomCompare=1`, used
by this visual check, and do not contaminate the performance benchmark.

Final same-frame High captures in `out/bloom/visual-webgpu`:

| View | Different pixels | Pixels with a channel delta > 1/255 | Mean absolute RGB delta /255 | Worst channel delta /255 |
| --- | ---: | ---: | ---: | ---: |
| Noon / dawn, fit-all and beacon | 0% | 0% | 0 | 0 |
| Night, fit-all | 0.3146% | 0.0045% | 0.001188 | 12 |
| Night, beacon closeup | 5.8226% | 0.1280% | 0.024803 | 39 |

Every repeated control had zero differences. WebGL's six comparisons in
`out/bloom/visual-webgl` were bit-identical because both paths retain native storage.
Captures use `index-xzNKmrlS.js`. Screenshots do not exclude precision artifacts on
other scenes, displays or devices, including altered gradients near bright details.
An additional Eco night check at 1279×799 (`out/bloom/visual-eco-odd`) validates
unaligned GPU readback and quarter-resolution bloom. Its beacon closeup had
0.0666% of pixels with a channel delta > 1/255, but a worst delta of 66/255.
This is another reason to retain worst-case details alongside the small mean.
A separate control with the same Eco/resolution settings and FXAA disabled
(`out/bloom/visual-eco-no-fxaa`) reduced the worst closeup delta to 2/255, with
mean 0.024631/255. This supports FXAA amplifying small storage differences at
edges. Animation states differ between these runs, so it is evidence of that
interaction, not a universal bound on packed-format error.

```sh
CITY_WORLD=out/pipeline/reference-2026-10-04/world.json \
CITY_RUNS=4 CITY_DURATION_MS=5000 CITY_WARMUP_MS=3000 \
CITY_VARIANTS=baseline,bloom-reference CITY_OUTPUT=out/bloom/next \
bun run bench:pipeline

CITY_WORLD=out/pipeline/reference-2026-10-04/world.json \
CITY_OUTPUT=out/bloom/visual-webgpu bun run check:bloom

CITY_BACKEND=webgl CITY_WORLD=out/pipeline/reference-2026-10-04/world.json \
CITY_OUTPUT=out/bloom/visual-webgl bun run check:bloom
```

Each future optimization must record its **kind** (same calculations, reduced
precision, changed resolution/samples or effect removal), measured GPU/CPU gain,
memory scope, visual differences and uncertainty. The earlier paired-Gaussian-tap
experiment did not show a convincing whole-frame gain and was not retained.

### WebGPU / WebGL comparison

`bun run bench:backends` alternates hardware WebGPU and WebGL captures sequentially,
defaults to Smooth/60 fps and the same 1280×800 DPR 1 workload, and writes raw
reports plus `comparison.json` / `comparison.md`. It verifies the production asset
does not change mid-comparison. Two scenarios distinguish backend behavior:

- **native-high**: normal High for each backend. WebGL caps AO at 8 instead of 16,
  limits local lighting and uses the fallback lighthouse cone without raymarching
  or a lighthouse shadow. It also retains native bloom storage. Thus this scenario
  measures actual application behavior, not identical image quality.
- **common-effects**: AO 8, native RGBA16F bloom, local lights off, raymarching off,
  lighthouse shadow off. Water, AO denoise, sun shadows, tone mapping and FXAA stay
  active. This better controls effect differences but is not the full night look.

WebGPU exclusive GPU pass sums and WebGL whole-pipeline elapsed queries are
separate columns, never used to calculate a cross-backend GPU speedup percentage.
FPS and CPU observations are also recorded with GPU queries disabled for
`CITY_CONTROL_MS` (default 3 s) on the same page after each capture. This controls
query overhead; FPS remains bounded by the selected frame ceiling. Three's tracked
allocation counters are not OS VRAM measurements.

The 2026-10-04 hardware run has three repetitions × 5 s (24 captures) in
`out/bloom/backends`, plus one repetition × 3 s with 3 s no-query controls
(8 captures) in `out/bloom/backend-controls`. Same world, healthy fixture and camera
as the bloom benchmark, but Smooth/60 fps. Native GPU time columns have different
scopes and are not a GPU speedup claim:

| Scenario / time | WebGPU exclusive GPU ms (3-run median) | WebGL elapsed GPU ms (3-run median) | WebGPU FPS without queries (1 control) | WebGL FPS without queries (1 control) |
| --- | ---: | ---: | ---: | ---: |
| Native High, noon | 8.92 | 13.49 | 60.0 | 43.0 |
| Native High, night | 10.45 | 13.38 | 60.0 | 42.6 |
| Common effects, noon | 9.36 | 8.80 | 60.1 | 56.2 |
| Common effects, night | 8.47 | 8.79 | 60.0 | 57.1 |

Ordinary frame cadence is close to the profiled cadence in the controls. WebGL
does not establish an advantage for the current full look on this machine; the
closer common-effects results also show why native High should not be called an
identical-quality comparison. No backend migration is included in this change.

```sh
CITY_WORLD=out/pipeline/reference-2026-10-04/world.json \
CITY_RUNS=3 CITY_DURATION_MS=5000 CITY_WARMUP_MS=3000 CITY_CONTROL_MS=3000 \
CITY_OUTPUT=out/bloom/backends-next bun run bench:backends
```

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
`scripts/harness.ts` (`--use-angle=vulkan --enable-features=Vulkan
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
