import { AdaptiveEvents, Html, OrbitControls } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { CameraTarget } from "../domain/camera";
import { TERRAIN } from "../domain/nodeStyle";
import { IDLE_FPS, initialTier, QUALITY_PROFILES } from "../domain/quality";
import type {
  City,
  CityMeta,
  CityMetrics,
  NodeTelemetry,
  PositionedNode,
  ResolvedLink,
} from "../domain/types";
import { buildShoreField } from "../layout/shore";
import type { WorldLayout } from "../layout/types";
import { EMPTY_INFRA, useMobilityStore } from "../store/mobilityStore";
import { useQualityTier, useUiStore } from "../store/uiStore";
import { BridgeMesh, deckWidth } from "./BridgeMesh";
import { BuildingAnimations } from "./buildings/BuildingAnimations";
import { CameraAnimator } from "./CameraAnimator";
import { CityScene } from "./CityScene";
import { bridgeDeck, deckClass, makeDriver } from "./geo/drivable";
import type { DeckExit } from "./geo/roadGraph";
import { HtmlPortalContext, useHtmlPortal } from "./htmlPortal";
import { LightingPipeline } from "./lighting/LightingPipeline";
import { LocalLighting } from "./lighting/LocalLighting";
import {
  createRenderer,
  gpuRenderer,
  isWebGPU,
  rendererDeviceInfo,
  renderParams,
} from "./lighting/renderer";
import { cachedInitializer } from "./lighting/rendererInitialization";
import { createLightingRuntime, LightingContext } from "./lighting/runtime";
import { SolarLighting } from "./lighting/SolarLighting";
import { ConstructionMarkers } from "./mobility/ConstructionMarkers";
import { IngressPorts } from "./mobility/IngressPorts";
import { MetroSystem } from "./mobility/MetroSystem";
import { MobilitySimulation } from "./mobility/MobilitySimulation";
import { PERF_HUD, PerfHud } from "./PerfTuning";
import { QualityGovernor, RenderScale } from "./QualityGovernor";
import { RenderLoop } from "./RenderLoop";
import { RouteOverlay } from "./RouteOverlay";
import { SceneDepth } from "./SceneDepth";
import { SkyEnvironment } from "./SkyEnvironment";
import { TrafficSystem } from "./TrafficSystem";
import { upgradeLayout, worldRoutes } from "./traffic/worldRoutes";
import { WaterPlane } from "./WaterPlane";

const FOG_NEAR = 40;
const FOG_FAR = 160;
const CAMERA_FAR = 400;
/** How far out the camera may pull, as a multiple of the world half-size. */
const MAX_DISTANCE_RATIO = 5;
/** Closest the camera may get: below this it clips through a building. */
const MIN_DISTANCE = 4;
/** Half-size of the shadow frustum for a small world, and the reference the rest scales from. */
const MIN_EXTENT = 60;
const REFERENCE_EXTENT = 120;
/** Breathing room around the outermost shore. */
const EXTENT_MARGIN = 12;
/** Hover ribbons ride above the deck so they win the raycast against the bridge. */
const BRIDGE_OVERLAY_LIFT = 0.04;
function Loader() {
  const portal = useHtmlPortal();
  return (
    <Html center portal={portal}>
      <div className="glass-morphic rounded-xl px-4 py-2 text-[12px] text-white">
        Loading models…
      </div>
    </Html>
  );
}

export function WorldScene({
  worldKey,
  cities,
  nodes,
  links,
  layout: baseLayout,
  visibleCities,
  cameraTarget,
  onNodeClick,
  onBackgroundClick,
  telemetry,
  cityMeta,
  cityMetrics,
}: {
  /** Identity of the loaded world, computed once in `App` (mobility store key). */
  worldKey: string;
  cities: City[];
  nodes: PositionedNode[];
  links: ResolvedLink[];
  /** Islands, streets and bridges. Absent → cities render their own fallback ground. */
  layout?: WorldLayout;
  visibleCities: Set<string>;
  cameraTarget: CameraTarget | null;
  onNodeClick: (pos: [number, number, number]) => void;
  onBackgroundClick?: () => void;
  telemetry?: Map<string, NodeTelemetry>;
  cityMeta?: Map<string, CityMeta>;
  cityMetrics?: Map<string, CityMetrics>;
}) {
  const infra = useMobilityStore((s) => s.worlds[worldKey] ?? EMPTY_INFRA);
  useEffect(() => {
    useMobilityStore.getState().setWorld(worldKey);
  }, [worldKey]);
  useEffect(() => {
    const state = useMobilityStore.getState();
    if (state.worldKey === worldKey) {
      state.syncBridgeAccesses(baseLayout?.bridges ?? []);
    }
  }, [baseLayout, worldKey]);
  const layout = useMemo(
    () => (baseLayout ? upgradeLayout(baseLayout, infra) : undefined),
    [baseLayout, infra],
  );
  const routes = useMemo(
    () => (layout ? worldRoutes(layout, links, infra) : []),
    [layout, links, infra],
  );
  const controlsRef = useRef<OrbitControlsImpl>(null);
  const [rendererAttempt, setRendererAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: GPU resources belong to one renderer generation.
  const lighting = useMemo(() => createLightingRuntime(), [rendererAttempt]);
  const savedCamera = useRef<{
    position: [number, number, number];
    target: [number, number, number];
  } | null>(null);
  const handleDeviceLost = useCallback(() => {
    const controls = controlsRef.current;
    if (controls) {
      savedCamera.current = {
        position: controls.object.position.toArray(),
        target: controls.target.toArray(),
      };
    }
    setRendererAttempt((attempt) => Math.min(3, attempt + 1));
  }, []);
  const initializeRenderer = useMemo(() => {
    const initialize = cachedInitializer(async (canvas: HTMLCanvasElement) => {
      const gl = await createRenderer(canvas, rendererAttempt >= 2, handleDeviceLost);
      // Pick the starting tier before any child mounts, so budgets are right on first draw.
      const renderer = gpuRenderer(gl);
      useUiStore.getState().setAutoTier(
        initialTier({
          backend: isWebGPU(renderer) ? "webgpu" : "webgl",
          ...rendererDeviceInfo(renderer),
          cores: navigator.hardwareConcurrency,
        }),
      );
      return gl;
    });
    return (defaults: { canvas: unknown }) => initialize(defaults.canvas as HTMLCanvasElement);
  }, [rendererAttempt, handleDeviceLost]);
  const renderMode = useUiStore((s) => s.renderMode);
  const idle = useUiStore((s) => s.idle);
  const profile = QUALITY_PROFILES[useQualityTier()];
  const fps = idle ? IDLE_FPS : renderMode === "office" ? 30 : 60;
  // Overlay that hosts every drei <Html>; state (not ref) so children re-render once it exists.
  const [portalEl, setPortalEl] = useState<HTMLDivElement | null>(null);
  const portalRef = useMemo(() => ({ current: portalEl }), [portalEl]);

  const handleFocus = useCallback(
    (pos: [number, number, number]) => onNodeClick(pos),
    [onNodeClick],
  );

  // Where a deck leaves each city: the bridgehead pavement opens there. Keyed by
  // city so every `CityScene` gets a stable array and only rebuilds its roads
  // when the bridges do. A widened bridge needs a wider mouth, so the opening
  // is taken from the same deck class the mesh and the traffic use.
  const deckExits = useMemo(() => {
    const out = new Map<string, DeckExit[]>();
    if (!layout) {
      return out;
    }
    for (const b of layout.bridges) {
      const [a, c] = b.waterSpan;
      const halfWidth = deckWidth(deckClass(infra.bridges[b.key])) / 2;
      const add = (city: string, exit: DeckExit) => out.set(city, [...(out.get(city) ?? []), exit]);
      add(b.cityA, { at: a, toward: c, halfWidth });
      add(b.cityB, { at: c, toward: a, halfWidth });
    }
    return out;
  }, [layout, infra]);

  // Inter-city bridges: one deck per pair of visible cities. Each link crossing
  // it keeps its own full drivable path (feeder streets + deck), elevated once
  // here and reused by the hover overlay and the traffic, so they agree.
  const visibleBridges = useMemo(() => {
    if (!layout) {
      return [];
    }
    // A crossing runs over both islands' street grids, so it can meet a roundabout
    // on either shore — the bridgeheads included, which the driver circles up to
    // the deck's bearing — and its lanes come from either city's roads.
    const networks = [...layout.cities.values()].map((c) => c.roads);
    const roundabouts = networks.flatMap((n) => n.roundabouts);
    const driver = makeDriver(networks);
    return layout.bridges
      .filter((b) => visibleCities.has(b.cityA) && visibleCities.has(b.cityB))
      .map((bridge) => {
        const klass = deckClass(infra.bridges[bridge.key]);
        return {
          bridge,
          klass,
          deck: bridgeDeck(bridge.waterSpan, roundabouts),
          crossings: bridge.crossings.map((crossing) => ({
            crossing,
            path: driver.crossing(crossing.points, crossing.waterSpan, klass),
          })),
        };
      });
  }, [layout, visibleCities, infra]);

  const bridgeOverlays = useMemo(
    () =>
      visibleBridges.flatMap(({ crossings }) =>
        crossings.map(({ crossing, path }) => ({
          crossing,
          points: path.points.map(
            ([x, y, z]) => [x, y + BRIDGE_OVERLAY_LIFT, z] as [number, number, number],
          ),
        })),
      ),
    [visibleBridges],
  );

  // How far the world spreads: the shadow frustum, the fog and the far plane all
  // follow it instead of the hard-coded ±60 that only fitted a single row of cities.
  const extent = useMemo(() => {
    let half = 0;
    for (const c of layout?.cities.values() ?? []) {
      half = Math.max(
        half,
        Math.abs(c.bounds.cx) + c.bounds.width / 2,
        Math.abs(c.bounds.cz) + c.bounds.height / 2,
      );
    }
    return Math.max(MIN_EXTENT, half + EXTENT_MARGIN);
  }, [layout]);
  // Only a world bigger than the original framing needs its depth cues stretched.
  const depthScale = Math.max(1, extent / REFERENCE_EXTENT);
  const camera = useMemo(
    () => ({
      position: [15, 15, 25] as [number, number, number],
      fov: 50,
      near: 1,
      far: CAMERA_FAR * depthScale,
    }),
    [depthScale],
  );
  /**
   * The sea has to outlast the fog at the furthest the camera can pull back, or
   * its edge shows as a horizon line: size it from that distance, not from the
   * islands alone, and let `SceneDepth` clamp the fog to it.
   */
  const waterRadius = Math.max(600, extent * MAX_DISTANCE_RATIO * 2);
  // The coastline the sea shades against. Hidden cities render nothing, so they
  // must leave no ghost shore either; same dependencies as `visibleBridges`, so
  // the bake only reruns when the world itself changes.
  const shore = useMemo(() => {
    if (!baseLayout) {
      return undefined;
    }
    const outlines = [...baseLayout.cities.values()]
      .filter((c) => visibleCities.has(c.cityId))
      .map((c) => c.outline);
    return outlines.length > 0 ? buildShoreField(outlines, TERRAIN.shoreReach) : undefined;
  }, [baseLayout, visibleCities]);

  return (
    <HtmlPortalContext.Provider value={portalRef}>
      <div
        ref={setPortalEl}
        className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
      />
      {rendererAttempt >= 3 ? (
        <div
          role="alert"
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white"
        >
          <p>The graphics connection was lost.</p>
          <button
            type="button"
            className="glass-button rounded px-3 py-2"
            onClick={() => setRendererAttempt(0)}
          >
            Restart view
          </button>
        </div>
      ) : (
        <Canvas
          key={rendererAttempt}
          gl={initializeRenderer}
          frameloop="never"
          shadows="percentage"
          // Render scale comes from the quality tier (`RenderScale`), never from interaction.
          // `regress()` suspends expensive hover raycasts, without resizing GPU targets.
          performance={{ min: 0.5 }}
          camera={
            savedCamera.current ? { ...camera, position: savedCamera.current.position } : camera
          }
          style={{ width: "100%", height: "100%" }}
          onPointerMissed={() => onBackgroundClick?.()}
        >
          <LightingContext.Provider value={lighting}>
            <BuildingAnimations>
              <RenderLoop fps={fps} />
              <RenderScale />
              <QualityGovernor />
              <fog attach="fog" args={["#b9d7ec", FOG_NEAR * depthScale, FOG_FAR * depthScale]} />
              <SolarLighting extent={extent} />
              <SkyEnvironment />
              <SceneDepth extent={extent} controlsRef={controlsRef} waterRadius={waterRadius} />
              {PERF_HUD && <PerfHud />}

              <WaterPlane size={waterRadius * 2} shore={shore} />

              <Suspense fallback={<Loader />}>
                {cities.map((city) => (
                  <CityScene
                    key={city.id}
                    city={city}
                    nodes={nodes}
                    links={links}
                    layout={layout?.cities.get(city.id)}
                    visible={visibleCities.has(city.id)}
                    onFocus={handleFocus}
                    telemetry={telemetry}
                    meta={cityMeta?.get(city.id)}
                    hostMetrics={cityMetrics?.get(city.id)}
                    exits={deckExits.get(city.id)}
                  />
                ))}

                {visibleBridges.map(({ bridge, deck, klass }) => (
                  <BridgeMesh key={bridge.key} deck={deck} klass={klass} />
                ))}

                {bridgeOverlays.map(({ crossing, points }) => (
                  <RouteOverlay
                    key={crossing.key}
                    link={crossing.link}
                    points={points}
                    fromTelemetry={telemetry?.get(
                      `${crossing.link.fromCityId}/${crossing.link.fromNodeId}`,
                    )}
                  />
                ))}

                {layout && (
                  <IngressPorts
                    layout={layout}
                    telemetry={telemetry}
                    visibleCities={visibleCities}
                  />
                )}
                <MobilitySimulation key={worldKey}>
                  {[...(layout?.cities.values() ?? [])]
                    .filter((c) => visibleCities.has(c.cityId) && infra.cities[c.cityId] === 2)
                    .map((city, _, all) => (
                      <MetroSystem
                        key={city.cityId}
                        city={city}
                        telemetry={telemetry}
                        passengerBudget={Math.min(24, Math.floor(160 / all.length))}
                      />
                    ))}
                  <ConstructionMarkers visibleCities={visibleCities} />
                  <TrafficSystem
                    key={worldKey}
                    routes={routes}
                    layout={layout}
                    telemetry={telemetry}
                    visibleCities={visibleCities}
                    infra={infra}
                    cityMetrics={cityMetrics}
                    cityMeta={cityMeta}
                    maxCars={profile.maxCars}
                    maxTrucks={profile.maxTrucks}
                  />
                </MobilitySimulation>
              </Suspense>

              {renderParams.get("localLights") !== "0" && <LocalLighting />}
              <LightingPipeline />

              <CameraAnimator
                target={cameraTarget}
                controlsRef={controlsRef}
                skipInitial={rendererAttempt > 0}
              />

              {/* Suspend hover raycasts during interaction; leave render resolution stable. */}
              <AdaptiveEvents />

              <OrbitControls
                makeDefault
                ref={controlsRef}
                target={savedCamera.current?.target}
                regress
                enableDamping
                dampingFactor={0.1}
                maxPolarAngle={Math.PI / 2.1}
                minDistance={MIN_DISTANCE}
                maxDistance={extent * MAX_DISTANCE_RATIO}
              />
            </BuildingAnimations>
          </LightingContext.Provider>
        </Canvas>
      )}
    </HtmlPortalContext.Provider>
  );
}
