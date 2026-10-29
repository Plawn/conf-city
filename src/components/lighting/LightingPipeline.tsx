import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { Layers, type Material, Mesh, Vector3 } from "three";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { fxaa } from "three/addons/tsl/display/FXAANode.js";
import { gaussianBlur } from "three/addons/tsl/display/GaussianBlurNode.js";
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
  packNormalToRGB,
  pass,
  renderOutput,
  rtt,
  sample,
  screenCoordinate,
  screenUV,
  smoothstep,
  uniform,
  unpackRGBToNormal,
  vec3,
  vec4,
} from "three/tsl";
import {
  type Node,
  type NodeFrame,
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
import { createAmbientOcclusion } from "./ambientOcclusion";
import { createBeaconGeometry } from "./beaconGeometry";
import { CompactBloomNode } from "./CompactBloomNode";
import { renderProfiledPipeline } from "./PipelineProfiler";
import { gatePass } from "./passGate";
import { gpuRenderer, isWebGPU, renderParams } from "./renderer";
import { BEACON_VOLUME_LAYER, useLighting } from "./runtime";

/** The AO denoise target first, at the top level, then the composed pipeline. */
function renderFrame(
  renderer: ConstructorParameters<typeof RenderPipeline>[0],
  resources: { pipeline: RenderPipeline; filteredTexture: ReturnType<typeof rtt> | null },
) {
  if (resources.filteredTexture) {
    resources.filteredTexture.textureNeedsUpdate = true;
    resources.filteredTexture.updateBefore({ renderer } as NodeFrame);
  }
  resources.pipeline.render();
}

/** Shared by the real pipeline and the opt-in, same-frame bloom reference capture. */
function createOutputPipeline(
  renderer: ConstructorParameters<typeof RenderPipeline>[0],
  color: Node<"vec3">,
  alpha: Node<"float">,
  glow: ReturnType<typeof bloom> | null,
) {
  const pipeline = new RenderPipeline(renderer);
  pipeline.outputColorTransform = false;
  const composition = renderOutput(vec4(glow ? color.add(glow.rgb) : color, alpha));
  // Tone-mapped sRGB fits 8 bits, halving the bandwidth of FXAA's intermediate.
  const composed =
    renderParams.get("antialias") === "0"
      ? null
      : rtt(composition, null, null, { type: UnsignedByteType });
  if (composed) {
    composed.renderTarget!.texture.userData.profileLabel =
      "City composition / tone mapping (FXAA input)";
  }
  const antialias = composed ? fxaa(composed) : null;
  pipeline.outputNode = antialias ?? composition;
  return { pipeline, composed, antialias };
}

/** Owns the sole composed render; positive priority disables R3F's automatic draw. */
export function LightingPipeline() {
  const { gl, scene, camera, get } = useThree();
  const renderer = gpuRenderer(gl);
  const runtime = useLighting();
  // Destructured: the pipeline is rebuilt only for the budgets it actually reads.
  const { ao: aoBudget, volume: volumeBudget, bloomScale } = useQualityProfile();
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
    const shading = aoBudget.enabled && renderParams.get("ao") !== "0";
    const indirect = renderParams.get("ssgi") === "1" && isWebGPU(renderer);
    const scenePass = pass(scene, camera, { samples: 0 });
    scenePass.renderTarget.texture.userData.profileLabel = "City scene (MRT / materials / lights)";
    // Only write attachments that an enabled effect actually reads. In particular,
    // Eco needs neither normals nor emission; bloom reads the HDR beauty directly.
    if (shading || indirect) {
      scenePass.setMRT(
        mrt({ output, normal: packNormalToRGB(normalView), ...(shading ? { emissive } : {}) }),
      );
      scenePass.getTexture("normal").type = UnsignedByteType;
    }
    const beauty = scenePass.getTextureNode("output");
    const packedNormals = shading || indirect ? scenePass.getTextureNode("normal") : null;
    const normals = packedNormals
      ? sample((uv) => unpackRGBToNormal(packedNormals.sample(uv)))
      : null;
    const depth = scenePass.getTextureNode("depth");
    const emission = shading ? scenePass.getTextureNode("emissive") : null;
    // Contact shading is the tier's call: eco skips the half-resolution GTAO and its
    // denoise entirely rather than running them at a lower quality.
    const aoReference = renderParams.get("ao") === "reference";
    const aoOptions = {
      samples: isWebGPU(renderer) ? aoBudget.samples : Math.min(8, aoBudget.samples),
      denoise: aoBudget.denoise,
      reference: aoReference,
    };
    const contact =
      shading && normals ? createAmbientOcclusion(depth, normals, camera, aoOptions) : null;
    const {
      ambient = null,
      filtered = null,
      filteredTexture = null,
      occlusion = null,
    } = contact ?? {};
    const referenceContact =
      contact && normals && renderParams.get("aoCompare") === "1"
        ? createAmbientOcclusion(depth, normals, camera, {
            ...aoOptions,
            reference: true,
            noise: filtered?.noiseNode,
          })
        : null;
    const factor = occlusion ? mix(vec3(1), vec3(occlusion.r), 0.65) : vec3(1);
    // Keep emissive signals out of the AO multiply; apply bloom to the final HDR result.
    let color = emission
      ? max(beauty.rgb.sub(emission.rgb), vec3(0)).mul(factor).add(emission.rgb)
      : beauty.rgb;
    const referenceFactor = referenceContact
      ? mix(vec3(1), vec3(referenceContact.occlusion.r), 0.65)
      : factor;
    let referenceColor = emission
      ? max(beauty.rgb.sub(emission.rgb), vec3(0)).mul(referenceFactor).add(emission.rgb)
      : beauty.rgb;
    const gi =
      indirect && normals ? ssgi(beauty, depth, normals, camera as PerspectiveCamera) : null;
    // Bloom reads the raw beauty: emission already skips the AO multiply, so the bright
    // pixels match, and the high pass no longer re-evaluates the whole composition.
    let glowInput = beauty.rgb;
    if (gi) {
      gi.useTemporalFiltering = false;
      gi.sliceCount.value = 2;
      gi.stepCount.value = 4;
      color = color.add(gi.getGINode().rgb.mul(0.3));
      referenceColor = referenceColor.add(gi.getGINode().rgb.mul(0.3));
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
    const volumeEnabled = isWebGPU(renderer) && volumeBudget && renderParams.get("volume") !== "0";
    if (volumeEnabled) {
      color = color.add(volumeBlur.getTextureNode().rgb);
      referenceColor = referenceColor.add(volumeBlur.getTextureNode().rgb);
      glowInput = glowInput.add(volumeBlur.getTextureNode().rgb);
    }
    // A zero scale would allocate zero-sized mips, so no bloom node at all then.
    const glow =
      renderParams.get("bloom") === "0" || bloomScale <= 0
        ? null
        : renderParams.get("bloom") !== "reference" &&
            isWebGPU(renderer) &&
            renderer.hasFeature("rg11b10ufloat-renderable")
          ? new CompactBloomNode(vec4(glowInput, beauty.a), 0.25, 0.3, 1.15)
          : bloom(vec4(glowInput, beauty.a), 0.25, 0.3, 1.15);
    glow?.setResolutionScale(bloomScale);
    const outputPipeline = createOutputPipeline(renderer, color, beauty.a, glow);
    // Allocate a separate native node only for explicit visual comparisons. It
    // reads the same HDR scene textures, so animations cannot mask blur differences.
    const referenceGlow =
      glow && renderParams.get("bloomCompare") === "1"
        ? bloom(vec4(glowInput, beauty.a), 0.25, 0.3, 1.15).setResolutionScale(bloomScale)
        : null;
    if (referenceGlow && referenceContact) {
      throw new Error("Compare one effect at a time: bloomCompare or aoCompare");
    }
    const reference =
      referenceGlow || referenceContact
        ? {
            ...createOutputPipeline(
              renderer,
              referenceContact ? referenceColor : color,
              beauty.a,
              referenceGlow ?? glow,
            ),
            glow: referenceGlow,
            filteredTexture: referenceContact?.filteredTexture ?? filteredTexture,
          }
        : null;
    return {
      ...outputPipeline,
      reference,
      referenceContact,
      contact,
      aoOptions,
      scenePass,
      ambient,
      filtered,
      filteredTexture,
      glow,
      gi,
      volume,
      volumeEnabled,
      volumePass,
      volumeBlur,
      volumeMaterial,
      volumeGeometry,
      beamOrigin,
      beamDirection,
      beamRange,
    };
  }, [renderer, scene, camera, runtime.frameWork, aoBudget, volumeBudget, bloomScale]);
  useEffect(
    () => () => {
      resources.pipeline.dispose();
      resources.scenePass.dispose();
      resources.referenceContact?.dispose();
      resources.contact?.dispose();
      resources.composed?.renderTarget?.dispose();
      resources.glow?.dispose();
      resources.gi?.dispose();
      resources.volumePass.dispose();
      resources.volumeBlur.dispose();
      resources.volumeMaterial.dispose();
      resources.volumeGeometry.dispose();
      resources.antialias?.dispose();
      resources.reference?.pipeline.dispose();
      resources.reference?.composed?.renderTarget?.dispose();
      resources.reference?.antialias?.dispose();
      resources.reference?.glow?.dispose();
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
          water: {
            enabled: !!scene.getObjectByName("City water"),
            mode: api.waterMode,
          },
          ao: {
            enabled: resources.ambient !== null,
            ...resources.aoOptions,
            storage: resources.filteredTexture
              ? resources.aoOptions.reference
                ? "rgba16f"
                : "r16f"
              : "none",
          },
          bloom: {
            enabled: resources.glow !== null,
            storage: resources.glow instanceof CompactBloomNode ? "r11g11b10f" : "rgba16f",
            resolutionScale: resources.glow?.getResolutionScale() ?? 0,
          },
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
      async capture(reference = false, refreshScene = false) {
        if (reference && !resources.reference) {
          throw new Error(
            "Reference capture requires an enabled effect and bloomCompare=1 or aoCompare=1",
          );
        }
        const target = new RenderTarget(gl.domElement.width, gl.domElement.height, {
          type: UnsignedByteType,
        });
        const previous = renderer.getRenderTarget();
        try {
          renderer.setRenderTarget(target);
          if (refreshScene) {
            // FRAME nodes cache the beauty/effects for the entire RAF. A material
            // comparison must redraw those inputs without advancing animation time.
            const frame = { renderer } as unknown as NodeFrame;
            resources.scenePass.updateBefore(frame);
            resources.ambient?.updateBefore(frame);
            resources.gi?.updateBefore(frame);
            if (resources.volumeEnabled) {
              resources.volumePass.updateBefore(frame);
              resources.volumeBlur.updateBefore(frame);
            }
            resources.glow?.updateBefore(frame);
          }
          renderFrame(
            renderer,
            reference
              ? {
                  pipeline: resources.reference!.pipeline,
                  filteredTexture: resources.reference!.filteredTexture,
                }
              : resources,
          );
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
      get waterMode(): string {
        const water = scene.getObjectByName("City water") as Mesh | undefined;
        const resources = water?.userData.water;
        return resources && water?.material === resources.referenceMaterial
          ? "reference"
          : (resources?.mode ?? "none");
      },
      setWaterReference(reference: boolean) {
        const water = scene.getObjectByName("City water") as Mesh | undefined;
        const resources = water?.userData.water;
        if (!water || !resources?.referenceMaterial) {
          throw new Error("Water reference switching requires waterCompare=1");
        }
        water.material = reference ? resources.referenceMaterial : resources.material;
      },
      async captureWaterComparison() {
        const water = scene.getObjectByName("City water") as Mesh | undefined;
        const materials = water?.userData.water as
          | {
              referenceMaterial: Material | null;
              material: Material;
            }
          | undefined;
        if (!water || !materials?.referenceMaterial) {
          throw new Error("Water comparison requires waterCompare=1 and enabled water");
        }
        const original = water.material;
        const visible = water.visible;
        const images: Promise<string>[] = [];
        try {
          water.material = materials.referenceMaterial;
          // Prime FRAME dependencies for this RAF before the measured captures.
          // Explicit redraws below then use the same cached animation uniforms.
          images.push(api.capture(false, true));
          images.push(api.capture(false, true), api.capture(false, true));
          water.material = materials.material;
          images.push(api.capture(false, true), api.capture(false, true));
          // Reject a cached scene masquerading as an identical material comparison.
          water.visible = false;
          images.push(api.capture(false, true), api.capture(false, true));
        } finally {
          water.material = original;
          water.visible = visible;
        }
        const captures = await Promise.all(images);
        return {
          reference: captures[1]!,
          referenceControl: captures[2]!,
          optimized: captures[3]!,
          optimizedControl: captures[4]!,
          withoutWater: captures[5]!,
          withoutWaterControl: captures[6]!,
        };
      },
      async captureBloomComparison() {
        if (!resources.reference || renderParams.get("bloomCompare") !== "1") {
          throw new Error("Bloom comparison requires bloomCompare=1 and enabled bloom");
        }
        // Queue every render/readback synchronously, before yielding to RAF. The
        // scene's animation uniforms, traffic and camera stay identical throughout.
        // Repeated controls distinguish blur differences from capture instability.
        const reference = api.capture(true);
        const referenceControl = api.capture(true);
        const optimized = api.capture();
        const optimizedControl = api.capture();
        const images = await Promise.all([
          reference,
          referenceControl,
          optimized,
          optimizedControl,
        ]);
        return {
          reference: images[0]!,
          referenceControl: images[1]!,
          optimized: images[2]!,
          optimizedControl: images[3]!,
        };
      },
      async captureAoComparison() {
        if (!resources.reference || !resources.referenceContact) {
          throw new Error("AO comparison requires aoCompare=1 and enabled AO");
        }
        const images = await Promise.all([
          api.capture(true),
          api.capture(true),
          api.capture(),
          api.capture(),
        ]);
        return {
          reference: images[0]!,
          referenceControl: images[1]!,
          optimized: images[2]!,
          optimizedControl: images[3]!,
        };
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
    renderProfiledPipeline(renderer, () => renderFrame(renderer, resources));
  }, 1);
  return <primitive object={resources.volume} />;
}
