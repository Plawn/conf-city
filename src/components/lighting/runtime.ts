import { createContext, useContext } from "react";
import { Color, SpotLight, Vector3 } from "three";
import { uniform } from "three/tsl";
import { computeSolarState, resolveSolarInstant } from "../../domain/solar";
import { useLightingStore } from "../../store/lightingStore";
import { nightGate } from "./selection";

export const BEACON_VOLUME_LAYER = 10;
/** Empty layer that keeps shadow-camera masks non-default (see docs/lighting.md). */
export const SHADOW_CASTER_LAYER = 11;

export interface LocalLightSource {
  id: string;
  kind: "street" | "vehicle" | "beacon";
  position: Vector3;
  direction: Vector3;
  /** Half the headlight spacing, world units, along the vehicle's right; zero for other kinds. */
  lateral: Vector3;
  color: Color;
  intensity: number;
  range: number;
  angle: number;
  visible: boolean;
}

export function createLightingRuntime() {
  const settings = useLightingStore.getState();
  const solar = computeSolarState(
    resolveSolarInstant(settings.clock, Date.now()),
    settings.location,
  );
  return {
    solar,
    revision: -1,
    lastWall: 0,
    lastEdit: 0,
    environmentBakes: 0,
    frameWork: {
      volumePasses: 0,
      volumeBlurPasses: 0,
      buildingAnimationVisits: 0,
      buildingInstanceWrites: 0,
      /** Sun shadow map renders requested this frame (0 at rest once nothing moves). */
      sunShadowRenders: 0,
      /** Lighthouse shadow map renders requested this frame (0 by day). */
      beaconShadowRenders: 0,
    },
    /** Night light topology, flipped by `SolarLighting` with hysteresis. */
    nightLights: nightGate(false, solar.night),
    sources: new Map<string, LocalLightSource>(),
    shadowBeaconId: null as string | null,
    beaconLight: new SpotLight(0xffffff, 0, 18, 0.11, 0.6, 2),
    sunDirection: uniform(new Vector3(...solar.direction)),
    sunColor: uniform(new Color("#fff4df")),
    sunPower: uniform(solar.sunIntensity),
    night: uniform(solar.night),
    zenith: uniform(new Color("#528dd4")),
    horizon: uniform(new Color("#b9d7ec")),
    ground: uniform(new Color("#26354b")),
  };
}

export type LightingRuntime = ReturnType<typeof createLightingRuntime>;
export const LightingContext = createContext<LightingRuntime | null>(null);
export function useLighting() {
  const runtime = useContext(LightingContext);
  if (!runtime) {
    throw new Error("LightingContext missing");
  }
  return runtime;
}

export function createLightSource(id: string, kind: LocalLightSource["kind"]): LocalLightSource {
  return {
    id,
    kind,
    position: new Vector3(),
    direction: new Vector3(0, -1, 0),
    lateral: new Vector3(),
    color: new Color("#ffd7a0"),
    intensity: 0,
    range: 5,
    angle: 0.65,
    visible: true,
  };
}
