import type { WebGLRenderer } from "three";
import { DynamicLighting } from "three/addons/lighting/DynamicLighting.js";
import { ACESFilmicToneMapping, PCFShadowMap, WebGPURenderer } from "three/webgpu";
import { ActiveClusteredLighting } from "./ActiveClusteredLighting";

export const renderParams = new URLSearchParams(
  typeof window === "undefined" ? "" : window.location.search,
);
export const forceWebGL = renderParams.get("renderer") === "webgl";
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
      trackTimestamp: renderParams.has("perf"),
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
  renderer.shadowMap.type = PCFShadowMap;
  renderer.lighting = isWebGPU(renderer)
    ? new ActiveClusteredLighting(1024, 32, 24, 64)
    : new DynamicLighting({ maxDirectionalLights: 1, maxPointLights: 8, maxSpotLights: 9 });
  renderer.onDeviceLost = onLost;
  // R3F's custom-renderer hook supports this runtime contract; its public gl type is WebGL-only.
  return renderer as unknown as WebGLRenderer;
}
