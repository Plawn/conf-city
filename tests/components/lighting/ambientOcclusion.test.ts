import { expect, test } from "bun:test";
import { texture } from "three/tsl";
import { DataTexture, PerspectiveCamera, type TextureNode } from "three/webgpu";
import { createAmbientOcclusion } from "@/components/lighting/ambientOcclusion";

test("disposing an AO reference preserves the noise shared with the live filter", () => {
  const camera = new PerspectiveCamera();
  const input = new DataTexture();
  const options = { samples: 16, denoise: true, reference: false };
  const live = createAmbientOcclusion(texture(input), texture(input), camera, options);
  const noise = (live.filtered!.noiseNode as TextureNode).value;
  let noiseDisposals = 0;
  noise.addEventListener("dispose", () => noiseDisposals++);
  const reference = createAmbientOcclusion(texture(input), texture(input), camera, {
    ...options,
    reference: true,
    noise: live.filtered!.noiseNode,
  });
  expect(reference.filtered!.noiseNode).toBe(live.filtered!.noiseNode);
  let referenceTargetDisposals = 0;
  reference.filteredTexture!.renderTarget!.addEventListener(
    "dispose",
    () => referenceTargetDisposals++,
  );
  reference.dispose();
  expect(referenceTargetDisposals).toBe(1);
  expect(noiseDisposals).toBe(0);
  live.dispose();
  expect(noiseDisposals).toBe(1);
  input.dispose();
});
