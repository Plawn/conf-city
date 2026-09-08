# Solar and local lighting

The **Sun & lighting** panel uses Paris by default. Latitude, longitude and an IANA time zone can be changed independently. Location persists locally; every reload starts in live time. Preview changes lighting only, while traffic and telemetry continue.

SunCalc 2 computes the sun from the UTC instant and coordinates. Luxon handles civil dates, time zones and daylight saving: nonexistent local times are rejected and repeated times select their first occurrence. East is +X, north is −Z and up is +Y. Live lighting resynchronizes with wall time after the tab wakes. Polar days and nights have no invented sunrise or sunset.

## Rendering

The scene uses Three.js r185 `WebGPURenderer`, with its WebGL2 fallback and the same node-material pipeline. The old `onBeforeCompile` water shader and EffectComposer have been replaced. WebGPU requires a secure context (HTTPS or localhost).

Budgets marked *per tier* come from `src/domain/quality.ts`; the values below are the `high` tier — see [quality tiers](render-performance.md#quality-tiers) for `eco` and `balanced`.

| Layer | Implementation and budget |
| --- | --- |
| Sun | One directional light; PCF shadow map 2048² (per tier), updated at most 6 Hz (per tier) and immediately after a settings change. Cached world bounds are checked at the same cadence; only changed geometry/transforms are reprojected. The frustum is refitted when those bounds or the sun change. |
| Sky and water | Shared sun direction, radiance and horizon palette; daylight/twilight/night transitions. PMREM 64² reuses the same render target, updates at most every 30 seconds in live time or after a 250 ms settings debounce, and stays cached in a frozen preview. Night keeps an ambient floor. |
| Contact shading | Native GTAO at half resolution, 16 samples on WebGPU / 8 on WebGL2 (per tier; `eco` skips it), spatial denoising. Emissive signals are excluded from the AO multiply. |
| Street lamps | Instanced geometry and emissive bulbs; real point lights illuminate surfaces. GPU clustered lighting supports up to 1024 selected points (per tier). Ground discs are only a faint supplement. |
| Vehicles | Instanced front/rear bulbs follow the full vehicle pose, including bridge slopes. Brake intensity follows stable vehicle IDs. Up to 16 selected GPU spotlights represent headlight pairs (per tier). |
| Lighthouse | One selected GPU spotlight has a 512² shadow refreshed at 15 Hz and a half-resolution, 48-step volume (both per tier; `eco` uses the cone), with spatial dithering and a small Gaussian filter. Its proxy follows the beam instead of shading an enclosing sphere. The beam uses screen-space depth and the actual scene's shadow casters, with a soft distance fade and no transparent cone overlay. Other beacons and the WebGL2/daytime fallback retain a soft cone, corrected to widen away from the lamp. |
| WebGL2 local lights | At most 8 active local sources in total; no local shadow or volume pass. A pool of 9 spot objects reserves space for 8 vehicle slots plus the beacon; inactive slots have zero intensity. |
| Finish | HDR bloom, ACES tone mapping, FXAA. SSGI is optional and disabled by default. |

AO supplies contact shading; it does not produce the sunlight, projected headlights or street illumination. These are complementary effects. Headlights and street lamps have no individual shadow maps. Screen-space AO/GI cannot see off-screen geometry, and the cone fallback does not simulate volumetric shadowing.

Source selection runs at 5 Hz using frustum intersection, distance, intensity and retention hysteresis; slots fade during replacement. Vehicle source removal follows pool IDs rather than mutable array indexes. Geometry, materials, render targets and light registries are released on unmount.

The lighthouse still reports the worst CPU/memory/disk utilization using the existing colors and sweep speed. Service-only data still blinks; missing data remains dark. Reduced-motion preference freezes sweeping/pulsing and the tooltip identifies partial data.

The volume and its spotlight share a dedicated render layer in the main scene. Three.js r185's native raymarch loop reads the pass's lighting; assigning a material light list while rendering an empty secondary scene did not supply the projector to that loop. Scene depth is explicitly sampled with screen coordinates rather than cone UVs. The layer also allows volumetric occlusion to reuse the world shadow map.

Shadow fitting reads the previous render's world matrices, avoiding a second forced scene-wide matrix update. Growing buildings can therefore lag by one frame in the bounds calculation, covered by the existing six-unit margin. Hidden/removed objects leave the union at the next 6 Hz check, and late-loaded or replaced geometry is included automatically.

The existing 30/60 fps selector still controls simulation and rendering. Hidden tabs suspend work. WebGPU submissions are limited to two outstanding frames to avoid building an unbounded GPU queue. After device loss the view rebuilds, preserving camera, solar settings and telemetry; repeated losses switch to WebGL2, then show a restart action. In-flight visual traffic is recreated when Canvas is rebuilt.

Camera motion keeps the drawing-buffer resolution fixed. Three.js clustered lighting recreates its compute buffers and changes its shader cache key on resize. The previous `AdaptiveDpr` interaction setting could alternate half/full resolution while frames exceeded its 200 ms recovery delay, causing repeated shader compilation throughout orbit damping. Hover raycasts still pause during interaction; image quality stays at the resting resolution.

Inactive beacon volumes now clear their retained target to black once, run the blur once to consume that black input, then suspend both passes until the beam returns. The pipeline and texture bindings stay in place. A zero-intensity point light is excluded from the clustered data texture; even a tiny nonzero fade is retained. Empty cluster dispatches still run to clear old indices. Spotlights, shadowed lights, resolution, AO samples, bloom and lighting capacities are unchanged. Local selection reuses candidate records and slot collections at its existing 5 Hz cadence.

Node selection rings share their material and a bounded geometry cache (the existing building/port radii). Selecting a previously visited building no longer discards and recompiles its ring's GPU resources.

## Verification and measurement

```sh
bun test
bun run lint
bun run build
bun run preview --port 4174
# In another terminal; install Chromium once if needed:
bunx playwright install chromium
bun scripts/check-lighting.ts
CITY_BACKEND=webgl bun scripts/check-lighting.ts
CITY_RECOVERY=1 CITY_CASE=night bun scripts/check-lighting.ts
CITY_LIFECYCLE=1 CITY_CASE=night bun scripts/check-lighting.ts
CITY_BACKEND=webgl CITY_NO_GPU=1 CITY_CASE=night bun scripts/check-lighting.ts
bun scripts/check-camera.ts
CITY_BACKEND=webgl bun scripts/check-camera.ts
CITY_STABILITY=1 CITY_CASE=night bun scripts/check-lighting.ts
CITY_BEACON_CLOSEUP=1 CITY_REDUCED_MOTION=1 CITY_CASE=night bun scripts/check-lighting.ts
```

The browser script injects a fixed two-city telemetry fixture, frames a lighthouse, checks noon/dawn/night, validates the settings, checks persistence/live reset and optionally exercises recovery. It fails on console/page errors. PNGs and raw JSON measurements are written to `out/lighting/<backend>/` (ignored by git). Native GPU readback captures the composed image even when headless Chromium cannot composite a WebGPU canvas into a normal screenshot.

`?perf=1` displays backend, CPU submission time, asynchronous render + compute GPU timestamps when supported, draw calls and renderer-accounted memory. `window.__CITY_PERF__` exposes samples; `window.__CITY_RENDER__` exposes capture/inspection/focus/recovery helpers only in this mode. Renderer memory does not include all driver allocations.

See [rendering performance](render-performance.md) for building batching, sleeping animations, actual-adapter reporting, repeated measurements and larger-world fixtures.

`__CITY_PERF__.samples` retains up to 3,600 frame observations, including `volumePasses`, `volumeBlurPasses` (one blur update contains two draws), `clusterDispatches`, and `clusteredPointLightVisits` (summed across dispatches, not unique sources). GPU observations live separately in `gpuSamples`, with request/resolution times, render/compute durations and an ID. The frame's `gpuSampleId`/`gpuMs` refer to the latest completed asynchronous observation, not GPU work timed for that frame. Reports compute `gpuAsyncP95Ms` from distinct observations and leave it null when unavailable; resetting measurements discards results from outstanding requests in the old window.

Useful comparison switches:

| Setting | Purpose |
| --- | --- |
| `?renderer=webgl` | Force WebGL2 through the same renderer. |
| `?perf=1&ao=0` | Compare contact shading with AO disabled. |
| `?perf=1&volume=0` | Use the cone fallback for every lighthouse. |
| `?perf=1&ssgi=1` | Experimental GPU screen-space indirect lighting. |
| `?perf=1&lights=128` | Limit clustered point lights below the tier's budget; valid range 1–1024. |
| `?perf=1&quality=eco` | Force a quality tier (`eco`, `balanced`, `high`, `auto`) for one load. |
| `?idle=0` | Keep the Auto cadence when the window is unfocused or the pointer idle. |

Both scripts default to Smooth / 60 fps in their isolated browser context; `CITY_RENDER_MODE=office` selects 30 fps. They share the same telemetry fixture, refreshed every five seconds so traffic does not stop due to stale data. Lighting measurements last 30 seconds per case by default; the camera script waits for cars and trucks, warms rotation, wheel zoom and both application node-focus targets, then measures those interactions for 30 seconds per case at noon and night. Warm camera motion must produce zero buffer resizes and zero additional native GPU pipelines. Its reports include frame p95, percentage of intervals over 18 ms, CPU time, asynchronous GPU observations and adapter details. Native pipeline labels/times are recorded to distinguish first-use resources from recurring compilations.

The scripts run the `high` tier unless `CITY_PARAMS` contains `quality=`. They accept `CITY_PARAMS='&ao=0'`, `CITY_CASE=night`, `CITY_OUTPUT`, `CITY_URL`, `CHROMIUM_PATH`, `CITY_WIDTH`, `CITY_HEIGHT`, `CITY_DPR` and `CITY_DURATION_MS`. The default viewport is 960×600 at DPR 1; set it to match the target laptop when qualifying performance. `CITY_FRAMES=300` overrides the duration for the lighting script only. `GPU_SOFTWARE=1` enables SwiftShader flags and uses a two-second measurement window for functional smoke tests. The camera script also accepts `CAMERA_BASELINE=1` to record without pipeline/resize assertions and `CITY_ASSERT_60=1` to enforce frame p95 ≤18 ms on hardware (never on SwiftShader).

```sh
# Run sequentially on the target laptop, using the same viewport and DPR throughout.
CITY_OUTPUT=out/camera/full bun scripts/check-camera.ts
CITY_PARAMS='&ao=0' CITY_OUTPUT=out/camera/no-ao bun scripts/check-camera.ts
CITY_PARAMS='&volume=0' CITY_OUTPUT=out/camera/no-volume bun scripts/check-camera.ts
CITY_BACKEND=webgl CITY_OUTPUT=out/camera/webgl bun scripts/check-camera.ts
CITY_ASSERT_60=1 CITY_OUTPUT=out/camera/qualified bun scripts/check-camera.ts
# Verify retained textures across night → day → night, and hide/show source cleanup.
CITY_CASE=night CITY_TRANSITIONS=1 CITY_LIFECYCLE=1 bun scripts/check-lighting.ts
```

AO/volume switches isolate costs for diagnosis; they do not change the application's defaults. Qualification targets a 60 Hz display and at least 95% of intervals ≤18 ms. A CPU/GPU speedup on a software adapter does not establish that budget on an integrated GPU.

`CITY_STABILITY=1` checks that a frozen preview does not rebake the environment across the old 30-second refresh boundary, then changes the time and verifies that the GPU texture identity remains unchanged. `CITY_BEACON_CLOSEUP=1 CITY_REDUCED_MOTION=1 CITY_CASE=night` captures a stationary beam from the side and checks that its center is visibly lit, catching an empty volumetric pass even when shaders compile successfully.

On target hardware, compare the same viewport, DPR, camera, traffic fixture and render mode. Capture a warm 300+ frame window for each backend and each time of day. Record frame p95, CPU/GPU time, draws and memory; repeat with point caps 64/128/256 and AO/volume off to identify the limiting pass. Also exercise zoom, city visibility, large worlds and repeated configuration changes. A 30 fps target has a 33.3 ms frame budget; the default light limits are provisional until those hardware measurements pass.

## Validation in this workspace

The suite passes 214 tests. Coverage includes solar seasons/directions, polar conditions, Paris DST, settings persistence, shadow bounds, selection hysteresis, brakes, vehicle pose and source cleanup. Beacon regression coverage checks the lamp-side apex and outward opening, while shadow-cache checks cover unchanged transforms, growing buildings, visibility, late/replaced geometry and excluded descendants. Performance regression tests cover retained black pass output, reactivation after a failed clear, exact-zero point filtering with stable shader keys, nested light-list restoration, candidate reuse and distinct asynchronous GPU observations. Build and repository lint pass.

The performance follow-up rendered noon/dawn/night on WebGPU and WebGL2. A closeup kept the volumetric beam visible, with the same center brightness (33.5/255) as the pre-change commit `40e93a2`; night → noon → night, two city hide/show cycles and simulated device loss passed. Stable noon samples report zero volume/blur updates and zero clustered point visits; night reactivates those passes. At 800×500 on SwiftShader, the warmed WebGPU camera sequence reports zero buffer resizes and zero new render/compute pipelines at both noon and night (`out/camera/perf-final-webgpu-800/`). The WebGL2 sequence likewise reports zero resizes, shader compilations or program links (`out/camera/perf-final-webgl-shaders/`). These are functional checks, not evidence of 60 fps on the target laptop.

In a synthetic CPU check with 5,000 nested meshes and 100 warm repetitions, shadow-bound collection averaged about 4.0 ms before caching and 0.5 ms afterward. This measures that operation alone, not application frame rate or the reported one-second pauses on target hardware. The browser stability check also confirmed two environment bakes before and after 31 seconds of frozen preview, then a third bake into the same GPU texture after changing the time.

Production Chromium smoke tests rendered noon, dawn and night on both WebGPU and WebGL2 without shader errors. Automatic fallback with `navigator.gpu` unavailable, the experimental SSGI pass, and two hide/show cycles releasing and rebuilding all 26 static light sources also passed. A simulated WebGPU device-loss callback preserved the camera and preview. This checks application recovery; it is not a driver crash test.

The camera regression script performs actual pointer dragging and wheel zoom, waits through damping, and checks that no canvas dimension changes occurred. It also records native GPU pipeline creation counts. On the 800×500 SwiftShader fixture, the original orbit/zoom sequence caused 23 resolution transitions and 116 additional render pipelines (4 additional compute pipelines). The same sequence after the fix caused zero resizes and zero additional pipelines. Reports are generated under `out/camera/`; `CAMERA_BASELINE=1` records an older build without enforcing the resize assertion. These counts validate removal of the compilation churn, independently of hardware frame-rate targets.

This environment has no hardware GPU: SwiftShader timings do **not** establish 30 fps on an integrated GPU or a speedup over the old renderer. The initial reference image also lacked the later telemetry fixture and is not a controlled performance comparison. Hardware qualification, representative large-world stress measurements and final budget tuning remain to be run with the commands above. The production build emits a large-chunk advisory (roughly 630 KB gzip for the application bundle).

Implementation references: [Three.js WebGPU migration](https://threejs.org/manual/en/webgpurenderer.html), [clustered lights example](https://threejs.org/examples/webgpu_lights_clustered.html), [AO example](https://threejs.org/examples/webgpu_postprocessing_ao.html), [volume lighting example](https://threejs.org/examples/webgpu_volume_lighting.html), [SunCalc](https://github.com/mourner/suncalc), [Luxon](https://moment.github.io/luxon/api-docs/index.html).
