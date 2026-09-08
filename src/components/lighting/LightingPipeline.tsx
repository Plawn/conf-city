import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { Layers, Mesh, Vector3 } from "three";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { denoise } from "three/addons/tsl/display/DenoiseNode.js";
import { fxaa } from "three/addons/tsl/display/FXAANode.js";
import { gaussianBlur } from "three/addons/tsl/display/GaussianBlurNode.js";
import { ao } from "three/addons/tsl/display/GTAONode.js";
import { ssgi } from "three/addons/tsl/display/SSGINode.js";
import {
  emissive,
  float,
  interleavedGradientNoise,
  max,
  mix,
  mrt,
  normalView,
  output,
  pass,
  renderOutput,
  screenCoordinate,
  screenUV,
  smoothstep,
  uniform,
  vec3,
  vec4,
} from "three/tsl";
import {
  type Node,
  type PerspectiveCamera,
  RendererUtils,
  RenderPipeline,
  RenderTarget,
  UnsignedByteType,
  VolumeNodeMaterial,
} from "three/webgpu";
import type { OrbitControls } from "three-stdlib";
import { useQualityProfile, useUiStore } from "../../store/uiStore";
import { inspectBuildings } from "../buildings/instances";
import { createBeaconGeometry } from "./beaconGeometry";
import { renderProfiledPipeline } from "./PipelineProfiler";
import { gatePass } from "./passGate";
import { gpuRenderer, isWebGPU, renderParams } from "./renderer";
import { BEACON_VOLUME_LAYER, useLighting } from "./runtime";

/** Owns the sole composed render; positive priority disables R3F's automatic draw. */
export function LightingPipeline() {
  const { gl, scene, camera, get } = useThree();
  const renderer = gpuRenderer(gl);
  const runtime = useLighting();
  const profile = useQualityProfile();
  useEffect(() => {
    if (renderParams.get("profile") !== "1") {
      return;
    }
    let disposed = false;
    let detach: (() => void) | undefined;
    void import("./pipelineProfilePanel").then(({ attachPipelineProfilePanel }) => {
      if (!disposed) {
        detach = attachPipelineProfilePanel(renderer);
      }
    });
    return () => {
      disposed = true;
      detach?.();
    };
  }, [renderer]);
  const resources = useMemo(() => {
    const scenePass = pass(scene, camera, { samples: 0 });
    scenePass.renderTarget.texture.userData.profileLabel = "City scene (MRT / materials / lights)";
    scenePass.setMRT(mrt({ output, normal: normalView, emissive }));
    const beauty = scenePass.getTextureNode("output");
    const normals = scenePass.getTextureNode("normal");
    const depth = scenePass.getTextureNode("depth");
    const emission = scenePass.getTextureNode("emissive");
    // Contact shading is the tier's call: eco skips the half-resolution GTAO and the
    // full-resolution denoise entirely rather than running them at a lower quality.
    const shading = profile.ao.enabled && renderParams.get("ao") !== "0";
    const ambient = shading ? ao(depth, normals, camera) : null;
    let occlusion: Node<"vec4"> | null = null;
    let filtered: ReturnType<typeof denoise> | null = null;
    if (ambient) {
      ambient.resolutionScale = 0.5;
      ambient.samples.value = isWebGPU(renderer)
        ? profile.ao.samples
        : Math.min(8, profile.ao.samples);
      ambient.radius.value = 0.9;
      ambient.scale.value = 1;
      ambient.useTemporalFiltering = false;
      occlusion = ambient.getTextureNode() as unknown as Node<"vec4">;
      if (profile.ao.denoise) {
        filtered = denoise(ambient.getTextureNode(), depth, normals, camera);
        filtered.radius.value = 3;
        occlusion = filtered as unknown as Node<"vec4">;
      }
    }
    const factor = occlusion ? mix(vec3(1), vec3(occlusion.r), 0.65) : vec3(1);
    // Keep emissive signals out of the AO multiply; apply bloom to the final HDR result.
    let color = max(beauty.rgb.sub(emission.rgb), vec3(0)).mul(factor).add(emission.rgb);
    const gi =
      renderParams.get("ssgi") === "1" && isWebGPU(renderer)
        ? ssgi(beauty, depth, normals, camera as PerspectiveCamera)
        : null;
    if (gi) {
      gi.useTemporalFiltering = false;
      gi.sliceCount.value = 2;
      gi.stepCount.value = 4;
      color = color.add(gi.getGINode().rgb.mul(0.3));
    }
    const volumeMaterial = new VolumeNodeMaterial({ steps: 48, fog: false });
    // Geometry UVs do not identify the scene pixel behind a raymarch sample.
    volumeMaterial.depthNode = depth.sample(screenUV);
    // Stable spatial dithering avoids moving noise when reduced motion is enabled.
    volumeMaterial.offsetNode = interleavedGradientNoise(screenCoordinate);
    const beamOrigin = uniform(new Vector3());
    const beamDirection = uniform(new Vector3(0, 0, 1));
    const beamRange = uniform(1);
    volumeMaterial.scatteringNode = ({ positionRay }) => {
      const along = positionRay.sub(beamOrigin).dot(beamDirection).div(beamRange);
      return float(3).mul(float(1).sub(smoothstep(0.65, 1, along)));
    };
    // Rasterize only the beam's silhouette. The old sphere shaded mostly empty air,
    // while just 12 samples often missed the narrow light altogether.
    const volumeGeometry = createBeaconGeometry(1, 1, false);
    const volume = new Mesh(volumeGeometry, volumeMaterial);
    volume.receiveShadow = true;
    volume.userData.excludeSunBounds = true;
    const volumeLayers = new Layers();
    volumeLayers.set(BEACON_VOLUME_LAYER);
    volume.layers.mask = volumeLayers.mask;
    // The native raymarch loop reads the pass's lights. Isolate the beacon and
    // volume by layer, in the same scene as the actual shadow casters.
    const volumePass = pass(scene, camera, { samples: 0, depthBuffer: false })
      .setLayers(volumeLayers)
      .setResolutionScale(0.5);
    volumePass.renderTarget.texture.userData.profileLabel = "City lighthouse volume";
    const volumeBlur = gaussianBlur(volumePass.getTextureNode(), 0.75, 2);
    gatePass(
      volumePass,
      () => volume.visible,
      () => runtime.frameWork.volumePasses++,
      () => {
        const state = RendererUtils.saveRendererState(renderer);
        RendererUtils.resetRendererState(renderer, state);
        try {
          renderer.setRenderTarget(volumePass.renderTarget);
          renderer.setClearColor(0x000000, 0);
          renderer.clear(true, false, false);
        } finally {
          RendererUtils.restoreRendererState(renderer, state);
        }
      },
    );
    gatePass(
      volumeBlur,
      () => volume.visible,
      () => runtime.frameWork.volumeBlurPasses++,
    );
    if (isWebGPU(renderer) && profile.volume && renderParams.get("volume") !== "0") {
      color = color.add(volumeBlur.getTextureNode().rgb);
    }
    const glow =
      renderParams.get("bloom") === "0" ? null : bloom(vec4(color, beauty.a), 0.25, 0.3, 1.15);
    glow?.setResolutionScale(profile.bloomScale);
    const pipeline = new RenderPipeline(renderer);
    pipeline.outputColorTransform = false;
    const antialias = fxaa(renderOutput(vec4(glow ? color.add(glow.rgb) : color, beauty.a)));
    antialias.textureNode.value.userData.profileLabel =
      "City composition / tone mapping (FXAA input)";
    pipeline.outputNode = antialias;
    return {
      pipeline,
      scenePass,
      ambient,
      filtered,
      glow,
      gi,
      volume,
      volumePass,
      volumeBlur,
      volumeMaterial,
      volumeGeometry,
      beamOrigin,
      beamDirection,
      beamRange,
      antialias,
    };
  }, [renderer, scene, camera, runtime.frameWork, profile]);
  useEffect(
    () => () => {
      resources.pipeline.dispose();
      resources.scenePass.dispose();
      resources.ambient?.dispose();
      resources.filtered?.dispose();
      resources.glow?.dispose();
      resources.gi?.dispose();
      resources.volumePass.dispose();
      resources.volumeBlur.dispose();
      resources.volumeMaterial.dispose();
      resources.volumeGeometry.dispose();
      resources.antialias.dispose();
    },
    [resources],
  );
  useEffect(() => {
    if (!renderParams.has("perf")) {
      return;
    }
    const api = {
      inspect() {
        let activeLights = 0;
        scene.traverse((object) => {
          if ("isLight" in object && "intensity" in object && Number(object.intensity) > 0) {
            activeLights++;
          }
        });
        return {
          buildings: inspectBuildings(scene, camera, gl.domElement.getBoundingClientRect()),
          altitude: runtime.solar.altitude,
          night: runtime.night.value,
          camera: camera.position.toArray(),
          target: (get().controls as OrbitControls | null)?.target.toArray(),
          activeLights,
          beacon: runtime.beaconLight.intensity,
          beaconDirection: runtime.beaconLight.target.position
            .clone()
            .sub(runtime.beaconLight.position)
            .normalize()
            .toArray(),
          shadowBeaconId: runtime.shadowBeaconId,
          environmentTexture: scene.environment?.uuid ?? null,
          environmentBakes: runtime.environmentBakes,
          sources: [...runtime.sources.values()].map((s) => ({
            id: s.id,
            kind: s.kind,
            position: s.position.toArray(),
            visible: s.visible,
          })),
        };
      },
      focus(position: [number, number, number], target: [number, number, number]) {
        // A diagnostic camera placement must not be overwritten by an unfinished UI flight.
        useUiStore.getState().setCamera(null);
        camera.position.set(...position);
        const controls = get().controls as OrbitControls | null;
        controls?.target.set(...target);
        controls?.update();
      },
      async capture() {
        const target = new RenderTarget(gl.domElement.width, gl.domElement.height, {
          type: UnsignedByteType,
        });
        const previous = renderer.getRenderTarget();
        try {
          renderer.setRenderTarget(target);
          resources.pipeline.render();
        } finally {
          renderer.setRenderTarget(previous);
        }
        try {
          const pixels = await renderer.readRenderTargetPixelsAsync(
            target,
            0,
            0,
            target.width,
            target.height,
          );
          const canvas = document.createElement("canvas");
          canvas.width = target.width;
          canvas.height = target.height;
          const context = canvas.getContext("2d")!;
          const row = target.width * 4;
          const gpu = isWebGPU(renderer);
          const stride = gpu ? Math.ceil(row / 256) * 256 : row;
          const data = new Uint8ClampedArray(row * target.height);
          // WebGPU readback retains 256-byte row alignment; WebGL is bottom-up.
          for (let y = 0; y < target.height; y++) {
            const start = (gpu ? y : target.height - 1 - y) * stride;
            data.set(pixels.subarray(start, start + row), y * row);
          }
          context.putImageData(new ImageData(data, target.width, target.height), 0, 0);
          return canvas.toDataURL("image/png");
        } finally {
          target.dispose();
        }
      },
      simulateDeviceLoss: () =>
        renderer.onDeviceLost({
          api: "WebGPU",
          message: "Test device loss",
          reason: "unknown",
          originalEvent: {},
        }),
    };
    window.__CITY_RENDER__ = api;
    return () => {
      if (window.__CITY_RENDER__ === api) {
        delete window.__CITY_RENDER__;
      }
    };
  }, [renderer, gl, resources, camera, get, runtime, scene]);
  useFrame(() => {
    const light = runtime.beaconLight;
    resources.volume.visible = light.intensity > 0.001 && runtime.night.value > 0.01;
    resources.volume.position.copy(light.position);
    resources.volume.lookAt(light.target.position);
    const radius = Math.tan(light.angle) * light.distance;
    resources.volume.scale.set(radius, radius, light.distance);
    resources.beamOrigin.value.copy(light.position);
    resources.beamDirection.value.copy(light.target.position).sub(light.position).normalize();
    resources.beamRange.value = Math.max(0.01, light.distance);
    renderProfiledPipeline(renderer, () => resources.pipeline.render());
  }, 1);
  return <primitive object={resources.volume} />;
}
