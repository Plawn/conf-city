import BloomNode from "three/addons/tsl/display/BloomNode.js";
import { type Node, type RenderTarget, RGBFormat, UnsignedInt101111Type } from "three/webgpu";

/** Private r185 fields: keep the native bloom algorithm, change only its storage. */
interface BloomTargets {
  _renderTargetBright: RenderTarget;
  _renderTargetsHorizontal: RenderTarget[];
  _renderTargetsVertical: RenderTarget[];
}

/**
 * Bloom consumes positive RGB only. R11G11B10 retains HDR range in four bytes
 * instead of RGBA16F's eight. It does reduce mantissa precision: visual checks
 * and the reference switch document that tradeoff rather than calling it lossless.
 */
export class CompactBloomNode extends BloomNode {
  constructor(input: Node<"vec4">, strength: number, radius: number, threshold: number) {
    super(input, strength, radius, threshold);
    const targets = this as unknown as BloomTargets;
    for (const target of [
      targets._renderTargetBright,
      ...targets._renderTargetsHorizontal,
      ...targets._renderTargetsVertical,
    ]) {
      target.texture.format = RGBFormat;
      target.texture.type = UnsignedInt101111Type;
    }
  }
}
