import { ClusteredLighting } from "three/addons/lighting/ClusteredLighting.js";
import ClusteredLightsNode from "three/addons/tsl/lighting/ClusteredLightsNode.js";
import type { Light, NodeFrame } from "three/webgpu";

export interface ClusterWork {
  dispatches: number;
  pointLightVisits: number;
}

export class ActiveClusteredLightsNode extends ClusteredLightsNode {
  work: ClusterWork | null = null;

  override setLights(lights: Light[]) {
    // Preserve the native light stack and material lights (including spotlights).
    // Only points live in a data texture; compacting them cannot change shader topology.
    super.setLights(lights);
    let count = 0;
    for (const light of this.clusteredLights) {
      if (light.intensity !== 0) {
        this.clusteredLights[count++] = light;
      }
    }
    this.clusteredLights.length = count;
    return this;
  }

  override updateBefore(frame: NodeFrame) {
    if (this.work) {
      this.work.dispatches++;
      this.work.pointLightVisits += this.clusteredLights.length;
    }
    // Keep the empty dispatch: it clears cluster indices left by the previous frame.
    return super.updateBefore(frame);
  }
}

export class ActiveClusteredLighting extends ClusteredLighting {
  readonly work: ClusterWork = { dispatches: 0, pointLightVisits: 0 };

  override createNode(lights: Light[] = []) {
    const node = new ActiveClusteredLightsNode(
      this.maxLights,
      this.tileSize,
      this.zSlices,
      this.maxLightsPerCluster,
    );
    node.work = this.work;
    return node.setLights(lights);
  }
}
