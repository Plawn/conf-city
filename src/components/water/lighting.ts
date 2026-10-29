import type { Light } from "three";
import {
  If,
  lightTargetDirection,
  normalView,
  normalWorld,
  positionViewDirection,
} from "three/tsl";
import {
  AnalyticLightNode,
  LightsNode,
  type Node,
  type NodeBuilder,
  PhysicalLightingModel,
  PointLightNode,
  SpotLightNode,
} from "three/webgpu";

const nonzero = (color: Node<"vec3">) =>
  color.r.notEqual(0).or(color.g.notEqual(0)).or(color.b.notEqual(0));

/** Preserve native PBR, but avoid shading analytic lights with zero contribution. */
export class WaterLightingModel extends PhysicalLightingModel {
  override start(builder: NodeBuilder) {
    // TSL caches these shared variables on first use. Initialize them outside
    // the light branches: IBL still needs them when sun/spot contributions are zero.
    normalView.toStack();
    normalWorld.toStack();
    // This accessor wraps its variable in Fn; an outer variable forces its
    // value to be built even when the stack requests a void output.
    positionViewDirection.toVar("waterViewDirection").toStack();
    const context = builder.context as {
      reflectedLight: { directDiffuse: Node<"vec3">; directSpecular: Node<"vec3"> };
    };
    context.reflectedLight.directDiffuse.toStack();
    context.reflectedLight.directSpecular.toStack();
    // Native start builds both direct and indirect lighting, so prime first.
    super.start(builder);
  }

  override direct(data: Parameters<PhysicalLightingModel["direct"]>[0], builder: NodeBuilder) {
    const node = data.lightNode;
    if (node instanceof LightsNode) {
      // Clustered lights already reject distance/cone misses before the BRDF.
      super.direct(data, builder);
      return;
    }
    if (!(node instanceof AnalyticLightNode) || !node.light) {
      // WebGL's batched lights supply attenuated colors and plain descriptors.
      // Their zero-color fragments need no BRDF, including empty light slots.
      If(nonzero(data.lightColor as Node<"vec3">), () => super.direct(data, builder));
      return;
    }
    const source = node as AnalyticLightNode<Light> & {
      baseColorNode: Node<"vec3"> | null;
      colorNode: Node<"vec3">;
    };
    // Read the unshadowed uniform first, so a disabled sun or lighthouse also
    // skips its shadow lookups. Test exact zero, with no intensity threshold.
    const color = source.baseColorNode ?? source.colorNode;
    If(nonzero(color), () => {
      const shade = () => super.direct(data, builder);
      if (node instanceof PointLightNode || node instanceof SpotLightNode) {
        const vector = node.getLightVector(builder) as Node<"vec3">;
        const radius = node.cutoffDistanceNode as Node<"float">;
        If(radius.lessThanEqual(0).or(vector.dot(vector).lessThanEqual(radius.mul(radius))), () => {
          if (node instanceof SpotLightNode) {
            const direction = data.lightDirection as Node<"vec3">;
            If(
              direction
                .dot(lightTargetDirection(node.light!))
                .greaterThan(node.coneCosNode as Node<"float">),
              shade,
            );
          } else {
            shade();
          }
        });
      } else {
        shade();
      }
    });
  }
}
