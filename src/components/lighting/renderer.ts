import type { WebGLRenderer } from "three";
import { DynamicLighting } from "three/addons/lighting/DynamicLighting.js";
import { ACESFilmicToneMapping, VSMShadowMap, WebGPURenderer } from "three/webgpu";
import { MAX_CLUSTERED_LIGHTS } from "../../domain/quality";
import { ActiveClusteredLighting } from "./ActiveClusteredLighting";

export const renderParams = new URLSearchParams(
  typeof window === "undefined" ? "" : window.location.search,
);
const forceWebGL = renderParams.get("renderer") === "webgl";
export const gpuRenderer = (renderer: unknown) => renderer as WebGPURenderer;
export function isWebGPU(renderer: WebGPURenderer): boolean {
  return (renderer.backend as unknown as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
}

/** Describe the device actually rendering the scene, rather than requesting another adapter. */
export function rendererDeviceInfo(renderer: WebGPURenderer) {
  if (isWebGPU(renderer)) {
    const info = (
      renderer.backend as unknown as {
        device: {
          adapterInfo?: {
            vendor: string;
            architecture: string;
            description: string;
            isFallbackAdapter?: boolean;
          };
        };
      }
    ).device.adapterInfo;
    return {
      vendor: info?.vendor ?? "",
      renderer: info?.description ?? "",
      architecture: info?.architecture ?? "",
      isFallbackAdapter: info?.isFallbackAdapter ?? null,
    };
  }
  const context = (renderer.backend as unknown as { gl: WebGL2RenderingContext }).gl;
  const debug = context.getExtension("WEBGL_debug_renderer_info");
  const description = debug ? String(context.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : "";
  return {
    vendor: debug ? String(context.getParameter(debug.UNMASKED_VENDOR_WEBGL)) : "",
    renderer: description,
    architecture: "",
    isFallbackAdapter: description
      ? /swiftshader|llvmpipe|softpipe|software/i.test(description)
      : null,
  };
}

export async function createRenderer(
  canvas: HTMLCanvasElement,
  fallback: boolean,
  onLost: () => void,
) {
  const make = (webgl: boolean) =>
    new WebGPURenderer({
      canvas,
      antialias: false,
      alpha: false,
      forceWebGL: webgl,
      trackTimestamp: renderParams.has("perf") || renderParams.get("profile") === "1",
    });
  let renderer = make(fallback || forceWebGL);
  try {
    await renderer.init();
  } catch (error) {
    renderer.dispose();
    if (fallback || forceWebGL) {
      throw error;
    }
    renderer = make(true);
    await renderer.init();
  }
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = true;
  // Variance maps: one bilinear read per fragment instead of five compares, and the
  // blur is paid per map render (rare) rather than per shaded pixel (every frame).
  renderer.shadowMap.type = VSMShadowMap;
  renderer.lighting = isWebGPU(renderer)
    ? new ActiveClusteredLighting(MAX_CLUSTERED_LIGHTS, 32, 24, 64)
    : new DynamicLighting({ maxDirectionalLights: 1, maxPointLights: 8, maxSpotLights: 9 });
  renderer.onDeviceLost = onLost;
  // R3F's custom-renderer hook supports this runtime contract; its public gl type is WebGL-only.
  return renderer as unknown as WebGLRenderer;
}
