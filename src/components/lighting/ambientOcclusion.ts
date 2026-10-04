import { denoise } from "three/addons/tsl/display/DenoiseNode.js";
import { ao } from "three/addons/tsl/display/GTAONode.js";
import { rtt } from "three/tsl";
import { type Camera, HalfFloatType, type Node, RedFormat, type TextureNode } from "three/webgpu";

/** Native GTAO and bilateral filter, with only the filtered AO channel stored. */
export function createAmbientOcclusion(
  depth: Node,
  normals: Node,
  camera: Camera,
  options: {
    samples: number;
    denoise: boolean;
    reference: boolean;
    noise?: Node;
  },
) {
  const ambient = ao(depth, normals, camera);
  ambient.resolutionScale = 0.5;
  ambient.samples.value = options.samples;
  ambient.radius.value = 0.9;
  ambient.scale.value = 1;
  ambient.useTemporalFiltering = false;
  const filtered = options.denoise
    ? denoise(ambient.getTextureNode(), depth, normals, camera)
    : null;
  const ownedNoise = filtered ? (filtered.noiseNode as TextureNode).value : null;
  if (filtered) {
    filtered.radius.value = 3;
    if (options.noise) {
      // Native DenoiseNode generates random noise per instance. A visual reference
      // must share that exact texture, not compare two different random filters.
      ownedNoise!.dispose();
      filtered.noiseNode = options.noise;
    }
  }
  // Composition reads only .r. Keep its half-float precision and omit unused
  // color channels and the fullscreen filter's depth attachment.
  const filteredTexture = filtered
    ? (options.reference
        ? rtt(filtered)
        : rtt(filtered, null, null, { format: RedFormat, type: HalfFloatType, depthBuffer: false })
      ).setResolutionScale(0.5)
    : null;
  if (filteredTexture) {
    // Update at the top level; nesting this RTT inside FXAA's RTT renders black.
    filteredTexture.autoUpdate = false;
    filteredTexture.renderTarget!.texture.userData.profileLabel = "City AO denoise";
  }
  return {
    ambient,
    filtered,
    filteredTexture,
    occlusion: (filteredTexture ?? ambient.getTextureNode()) as unknown as Node<"vec4">,
    dispose() {
      ambient.dispose();
      filtered?.dispose();
      // RTTNode.dispose() only fires an event; the target and generated noise are ours.
      filteredTexture?.renderTarget?.dispose();
      if (!options.noise) {
        ownedNoise?.dispose();
      }
    },
  };
}
