import { AdaptiveEvents, OrbitControls } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import type { CameraTarget } from "../domain/camera";
import { IDLE_FPS } from "../domain/quality";
import type {
  City,
  CityMeta,
  CityMetrics,
  NodeTelemetry,
  PositionedNode,
  ResolvedLink,
} from "../domain/types";
import {
  deckExits as deckExitsOf,
  bridgeOverlays as overlaysOf,
  visibleBridges as visibleBridgesOf,
  visibleShore,
  worldExtent,
} from "../geo/bridgeScene";
import type { WorldLayout } from "../layout/types";
import { upgradeLayout, worldRoutes } from "../sim/traffic/worldRoutes";
import { EMPTY_INFRA, useMobilityStore } from "../store/mobilityStore";
import { useQualityProfile, useUiStore } from "../store/uiStore";
import { BridgeMesh } from "./BridgeMesh";
import { BuildingAnimations } from "./buildings/BuildingAnimations";
import { CameraAnimator } from "./CameraAnimator";
import { CityScene } from "./CityScene";
import { HtmlPortalContext } from "./htmlPortal";
import { LightingPipeline } from "./lighting/LightingPipeline";
import { LocalLighting } from "./lighting/LocalLighting";
import { renderParams } from "./lighting/renderer";
import { LightingContext } from "./lighting/runtime";
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
import { SceneLoader } from "./SceneLoader";
import { SkyEnvironment } from "./SkyEnvironment";
import { TrafficSystem } from "./TrafficSystem";
import { useRendererRecovery } from "./useRendererRecovery";
import { WaterPlane } from "./WaterPlane";

const FOG_NEAR = 40;
const FOG_FAR = 160;
const CAMERA_FAR = 400;
/** How far out the camera may pull, as a multiple of the world half-size. */
const MAX_DISTANCE_RATIO = 5;
/** Closest the camera may get: below this it clips through a building. */
const MIN_DISTANCE = 4;
/** The world half-size the depth cues were tuned for. */
const REFERENCE_EXTENT = 120;

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
  const {
    controlsRef,
    rendererAttempt,
    setRendererAttempt,
    lighting,
    savedCamera,
    initializeRenderer,
  } = useRendererRecovery();
  const renderMode = useUiStore((s) => s.renderMode);
  const idle = useUiStore((s) => s.idle);
  const profile = useQualityProfile();
  const fps = idle ? IDLE_FPS : renderMode === "office" ? 30 : 60;
  // Overlay that hosts every drei <Html>; state (not ref) so children re-render once it exists.
  const [portalEl, setPortalEl] = useState<HTMLDivElement | null>(null);
  // Canvas re-applies its `dpr` prop (default [1, 2]) on every render, so the budget must live here.
  const [renderDpr, setRenderDpr] = useState<number>();
  const portalRef = useMemo(() => ({ current: portalEl }), [portalEl]);

  const handleFocus = useCallback(
    (pos: [number, number, number]) => onNodeClick(pos),
    [onNodeClick],
  );

  // Bridgehead openings per city, stable until the bridges change (see `geo/bridgeScene.ts`).
  const deckExits = useMemo(() => deckExitsOf(layout, infra), [layout, infra]);
  const visibleBridges = useMemo(
    () => visibleBridgesOf(layout, visibleCities, infra),
    [layout, visibleCities, infra],
  );
  const bridgeOverlays = useMemo(() => overlaysOf(visibleBridges), [visibleBridges]);
  const extent = useMemo(() => worldExtent(layout), [layout]);
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
  // Same dependencies as `visibleBridges`, so the bake only reruns when the world itself changes.
  const shore = useMemo(() => visibleShore(baseLayout, visibleCities), [baseLayout, visibleCities]);

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
          dpr={renderDpr}
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
              <RenderScale onDpr={setRenderDpr} />
              <QualityGovernor />
              <fog attach="fog" args={["#b9d7ec", FOG_NEAR * depthScale, FOG_FAR * depthScale]} />
              <SolarLighting extent={extent} />
              <SkyEnvironment />
              <SceneDepth extent={extent} controlsRef={controlsRef} waterRadius={waterRadius} />
              {PERF_HUD && <PerfHud />}

              <WaterPlane size={waterRadius * 2} shore={shore} />

              <Suspense fallback={<SceneLoader />}>
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
