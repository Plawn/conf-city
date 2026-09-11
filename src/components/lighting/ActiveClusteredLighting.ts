import { type Light, Lighting, type NodeFrame } from "three/webgpu";
import { ClusteredLightsNode } from "./clustered/ClusteredLightsNode";

export interface ClusterWork {
  dispatches: number;
  pointLightVisits: number;
  spotLightVisits: number;
}

export class ActiveClusteredLightsNode extends ClusteredLightsNode {
  work: ClusterWork | null = null;
  /** Spots among the compacted clustered lights, counted for the HUD. */
  clusteredSpots = 0;

  override setLights(lights: Light[]) {
    // Points and opted-in spots live in a data texture: compacting them never changes
    // shader topology, so a merged headlight pair costs nothing while its second spot is at 0.
    super.setLights(lights);
    let count = 0;
    let spots = 0;
    for (const light of this.clusteredLights) {
      if (light.intensity !== 0) {
        this.clusteredLights[count++] = light;
        if ((light as { isSpotLight?: boolean }).isSpotLight) {
          spots++;
        }
      }
    }
    this.clusteredLights.length = count;
    this.clusteredSpots = spots;
    return this;
  }

  override updateBefore(frame: NodeFrame) {
    if (this.work) {
      this.work.dispatches++;
      this.work.pointLightVisits += this.clusteredLights.length - this.clusteredSpots;
      this.work.spotLightVisits += this.clusteredSpots;
    }
    // Keep the empty dispatch: it clears cluster indices left by the previous frame.
    return super.updateBefore(frame);
  }
}

export class ActiveClusteredLighting extends Lighting {
  readonly work: ClusterWork = { dispatches: 0, pointLightVisits: 0, spotLightVisits: 0 };

  constructor(
    readonly maxLights = 1024,
    readonly tileSize = 32,
    readonly zSlices = 24,
    readonly maxLightsPerCluster = 64,
  ) {
    super();
  }

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
