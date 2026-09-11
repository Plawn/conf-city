/**
 * Fork of three's `ClusteredLightsNode` (examples/jsm/tsl/lighting) that also
 * clusters opted-in spotlights: vehicle headlights no longer run per fragment
 * across the whole screen. Lights sit in a 5-row data texture (`lightPacking`),
 * every light carries a cone so one shading path serves points and spots.
 */
import {
  attributeArray,
  Break,
  clamp,
  dot,
  Fn,
  float,
  getDistanceAttenuation,
  If,
  instanceIndex,
  int,
  ivec2,
  ivec4,
  Loop,
  log,
  max,
  min,
  positionView,
  pow,
  Return,
  renderGroup,
  screenCoordinate,
  smoothstep,
  textureLoad,
  uniform,
  vec3,
  vec4,
} from "three/tsl";
import {
  type Camera,
  DataTexture,
  FloatType,
  type Light,
  LightsNode,
  Matrix4,
  type NodeBuilder,
  type NodeFrame,
  NodeUpdateType,
  type PointLight,
  type Renderer,
  RGBAFormat,
  type SpotLight,
  Vector2,
} from "three/webgpu";
import {
  clusterKind,
  createBound,
  LIGHT_ROWS,
  type LightBound,
  lightBound,
  packLight,
  sliceRanges,
  sortByViewZ,
} from "./lightPacking";

export type ClusteredLight = PointLight | SpotLight;

/** Fields the node builder has at runtime but not in its typings. */
interface ClusterBuilder {
  renderer: Renderer;
  context: { reflectedLight: { directDiffuse: StackableNode; directSpecular: StackableNode } };
  lightsNode: LightsNode;
}

interface StackableNode {
  toStack(): unknown;
}

// biome-ignore lint/suspicious/noExplicitAny: TSL node objects are dynamically typed proxies.
type TslNode = any;

const _size = new Vector2();
// The TSL typings refuse the int/float mixing three's own JS relies on; treat builtins loosely.
const threadIndex: TslNode = instanceIndex;
const fragmentView: TslNode = positionView;
const fragmentCoordinate: TslNode = screenCoordinate;

export class ClusteredLightsNode extends LightsNode {
  static get type() {
    return "ClusteredLightsNode";
  }

  materialLights: Light[] = [];
  clusteredLights: ClusteredLight[] = [];
  readonly maxLights: number;
  readonly tileSize: number;
  readonly zSlices: number;
  readonly maxLightsPerCluster: number;

  private _allLights: Light[] = [];
  private readonly _chunksPerCluster: number;
  private _bufferSize: Vector2 | null = null;
  private _lightIndexes: TslNode = null;
  private _screenClusterIndex: TslNode = null;
  private _compute: TslNode = null;
  private _lightsTexture: DataTexture | null = null;
  private _zSliceRangesTexture: DataTexture | null = null;
  private _zSliceRangesData: Float32Array | null = null;
  private readonly _lightViewZ: Float32Array;
  private readonly _lightRadius: Float32Array;
  private readonly _lightBounds: LightBound[];
  private readonly _lightSortOrder: number[] = [];
  /** Lights packed by the previous update; an empty list stays empty without re-uploading. */
  private _packedCount = 0;
  private readonly _lightsCount: TslNode = uniform(0, "int");
  // Render-group uniforms: shared by compute and fragment passes, refreshed in updateBefore.
  private readonly _cameraNear: TslNode = uniform(0)
    .setName("clusteredCameraNear")
    .setGroup(renderGroup);
  private readonly _cameraFar: TslNode = uniform(0)
    .setName("clusteredCameraFar")
    .setGroup(renderGroup);
  private readonly _cameraViewMatrix: TslNode = uniform(new Matrix4())
    .setName("clusteredCameraViewMatrix")
    .setGroup(renderGroup);
  private readonly _cameraProjectionMatrix: TslNode = uniform(new Matrix4())
    .setName("clusteredCameraProjectionMatrix")
    .setGroup(renderGroup);
  private readonly _gridDimensions = uniform(new Vector2());

  constructor(maxLights = 1024, tileSize = 32, zSlices = 24, maxLightsPerCluster = 64) {
    super();
    this.maxLights = maxLights;
    this.tileSize = tileSize;
    this.zSlices = zSlices;
    this.maxLightsPerCluster = maxLightsPerCluster;
    this._chunksPerCluster = Math.ceil(maxLightsPerCluster / 4);
    this._lightViewZ = new Float32Array(maxLights);
    this._lightRadius = new Float32Array(maxLights);
    this._lightBounds = Array.from({ length: maxLights }, createBound);
    this.updateBeforeType = NodeUpdateType.RENDER;
  }

  override customCacheKey(): number {
    return (this._compute ? this._compute.getCacheKey() : 0) + super.customCacheKey();
  }

  /** Bounds, depth sort, texel rows and Z-slice ranges for the clustered lights. */
  updateLightsTexture(camera: Camera): void {
    const lightsTexture = this._lightsTexture;
    const zRanges = this._zSliceRangesData;
    const zRangesTexture = this._zSliceRangesTexture;
    if (!lightsTexture || !zRanges || !zRangesTexture) {
      return;
    }
    const clusteredLights = this.clusteredLights;
    const bounds = this._lightBounds;
    const viewZ = this._lightViewZ;
    const radius = this._lightRadius;
    // Upstream never clamps: more lights than texels overran the sort arrays.
    const count = Math.min(clusteredLights.length, this.maxLights);
    this._lightsCount.value = count;
    if (count === 0 && this._packedCount === 0) {
      return;
    }
    this._packedCount = count;
    const perspective = camera as Camera & { near?: number; far?: number };
    const near = perspective.near ?? 0.1;
    const far = perspective.far ?? 2000;
    for (let i = 0; i < count; i++) {
      lightBound(clusteredLights[i]!, far, bounds[i]!);
      radius[i] = bounds[i]!.radius;
    }
    const order = this._lightSortOrder;
    sortByViewZ(bounds, count, camera.matrixWorldInverse, viewZ, order);
    const data = lightsTexture.image.data as Float32Array;
    const lineSize = lightsTexture.image.width * 4;
    for (let i = 0; i < count; i++) {
      const index = order[i]!;
      packLight(data, lineSize, i, clusteredLights[index]!, bounds[index]!);
    }
    lightsTexture.needsUpdate = true;
    sliceRanges(viewZ, radius, order, count, near, far, this.zSlices, zRanges);
    zRangesTexture.needsUpdate = true;
  }

  override updateBefore(frame: NodeFrame): undefined {
    const { renderer, camera } = frame;
    if (!renderer || !camera) {
      return;
    }
    this.updateProgram(renderer);
    this.updateLightsTexture(camera);
    const perspective = camera as Camera & { near?: number; far?: number };
    this._cameraNear.value = perspective.near ?? 0.1;
    this._cameraFar.value = perspective.far ?? 2000;
    this._cameraViewMatrix.value = camera.matrixWorldInverse;
    this._cameraProjectionMatrix.value = camera.projectionMatrix;
    renderer.compute(this._compute);
  }

  override setLights(lights: Light[]): this {
    this._allLights = lights;
    const { clusteredLights, materialLights } = this;
    let materialIndex = 0;
    let clusteredIndex = 0;
    for (const light of lights) {
      if (clusterKind(light)) {
        clusteredLights[clusteredIndex++] = light as ClusteredLight;
      } else {
        materialLights[materialIndex++] = light;
      }
    }
    materialLights.length = materialIndex;
    clusteredLights.length = clusteredIndex;
    return super.setLights(materialLights);
  }

  override getLights(): Light[] {
    return this._allLights;
  }

  /** Light index (+1, 0 ends the list) stored in slot `element` of this fragment's cluster. */
  getTile(element: TslNode): TslNode {
    const slot = int(element);
    const stride = int(4);
    const chunkOffset = slot.div(stride);
    const idx = this._screenClusterIndex.mul(int(this._chunksPerCluster)).add(chunkOffset);
    return this._lightIndexes.element(idx).element(slot.mod(stride));
  }

  /** Row 0: culling sphere, centre moved to view space for the compute test. */
  getLightBound(index: TslNode) {
    const bound: TslNode = textureLoad(this._lightsTexture as DataTexture, ivec2(int(index), 0));
    const viewCenter: TslNode = this._cameraViewMatrix.mul(vec4(bound.xyz, 1.0)).xyz;
    return { viewCenter, radius: bound.w };
  }

  /** Rows 1-4: what the fragment loop shades with, in view space. */
  getLightShading(index: TslNode) {
    const texture = this._lightsTexture as DataTexture;
    const column = int(index);
    const dataB: TslNode = textureLoad(texture, ivec2(column, 1));
    const dataC: TslNode = textureLoad(texture, ivec2(column, 2));
    const dataD: TslNode = textureLoad(texture, ivec2(column, 3));
    const dataE: TslNode = textureLoad(texture, ivec2(column, 4));
    const viewPosition = this._cameraViewMatrix.mul(vec4(dataB.xyz, 1.0)).xyz;
    // Rigid view matrix: a unit direction stays unit, no normalize needed.
    const spotDirection = this._cameraViewMatrix.mul(vec4(dataD.xyz, 0.0)).xyz;
    return {
      viewPosition,
      distance: dataB.w,
      color: dataC.rgb,
      decay: dataC.w,
      spotDirection,
      coneCos: dataD.w,
      penumbraCos: dataE.x,
    };
  }

  override setupLights(builder: NodeBuilder, lightNodes: Parameters<LightsNode["setupLights"]>[1]) {
    const cluster = builder as unknown as ClusterBuilder;
    this.updateProgram(cluster.renderer);
    const lightingModel = cluster.context.reflectedLight;
    lightingModel.directDiffuse.toStack();
    lightingModel.directSpecular.toStack();
    super.setupLights(builder, lightNodes);
    Fn(() => {
      Loop(this.maxLightsPerCluster, ({ i }) => {
        const lightIndex = this.getTile(i);
        If(lightIndex.equal(int(0)), () => {
          Break();
        });
        const light = this.getLightShading(lightIndex.sub(1));
        const lightVector = light.viewPosition.sub(fragmentView);
        const distSq = dot(lightVector, lightVector);
        // Early-out: skip the BRDF beyond the light's cutoff.
        If(
          light.distance.equal(0).or(distSq.lessThanEqual(light.distance.mul(light.distance))),
          () => {
            const lightDirection = lightVector.normalize();
            // Points carry coneCos=-2 / penumbraCos=-1.5, so their cone factor is exactly 1.
            const cone: TslNode = smoothstep(
              light.coneCos,
              light.penumbraCos,
              lightDirection.dot(light.spotDirection),
            );
            // Most fragments of a touched cluster sit outside an 18° cone: skip the BRDF.
            If(cone.greaterThan(0), () => {
              const attenuation: TslNode = getDistanceAttenuation({
                lightDistance: lightVector.length(),
                cutoffDistance: light.distance,
                decayExponent: light.decay,
              });
              cluster.lightsNode.setupDirectLight(builder, this, {
                lightDirection,
                lightColor: light.color.mul(cone).mul(attenuation),
              });
            });
          },
        );
      });
    }, "void")();
  }

  getBufferFitSize(value: number): number {
    return Math.ceil(value / this.tileSize) * this.tileSize;
  }

  setSize(width: number, height: number): this {
    const fitWidth = this.getBufferFitSize(width);
    const fitHeight = this.getBufferFitSize(height);
    if (
      !this._bufferSize ||
      this._bufferSize.width !== fitWidth ||
      this._bufferSize.height !== fitHeight
    ) {
      this.create(fitWidth, fitHeight);
    }
    return this;
  }

  updateProgram(renderer: Renderer): void {
    renderer.getDrawingBufferSize(_size);
    const width = this.getBufferFitSize(_size.width);
    const height = this.getBufferFitSize(_size.height);
    if (
      this._bufferSize === null ||
      this._bufferSize.width !== width ||
      this._bufferSize.height !== height
    ) {
      this.create(width, height);
    }
  }

  create(width: number, height: number): void {
    const {
      tileSize,
      maxLights,
      zSlices,
      maxLightsPerCluster,
      _chunksPerCluster: chunksPerCluster,
    } = this;
    const bufferSize = new Vector2(width, height);
    const NX = Math.floor(bufferSize.width / tileSize);
    const NY = Math.floor(bufferSize.height / tileSize);
    const NZ = zSlices;
    const clusterCount = NX * NY * NZ;
    this._gridDimensions.value.set(NX, NY);
    // Upstream leaked the previous textures on every resize.
    this._lightsTexture?.dispose();
    this._zSliceRangesTexture?.dispose();
    this._packedCount = 0;
    const lightsData = new Float32Array(maxLights * 4 * LIGHT_ROWS);
    const lightsTexture = new DataTexture(lightsData, maxLights, LIGHT_ROWS, RGBAFormat, FloatType);
    // Per Z-slice light range for Z-culling (CPU-sorted, uploaded when lights change).
    const zSliceRangesData = new Float32Array(NZ * 4);
    const zSliceRangesTexture = new DataTexture(zSliceRangesData, NZ, 1, RGBAFormat, FloatType);
    // Per-cluster light-index storage (ivec4 chunks).
    const lightIndexesArray = new Int32Array(clusterCount * chunksPerCluster * 4);
    const lightIndexes: TslNode = attributeArray(lightIndexesArray, "ivec4").setName(
      "lightIndexes",
    );
    const getClusterChunk = (chunkIdx: TslNode) =>
      lightIndexes.element(threadIndex.mul(int(chunksPerCluster)).add(int(chunkIdx)));
    const getClusterSlot = (slotIdx: TslNode) => {
      const slot = int(slotIdx);
      const stride = int(4);
      const chunkOffset = slot.div(stride);
      const idx = threadIndex.mul(int(chunksPerCluster)).add(chunkOffset);
      return lightIndexes.element(idx).element(slot.mod(stride));
    };
    // Compute: one thread per cluster, sphere/AABB test in view space.
    const compute = Fn(() => {
      // view_x = ndc_x * (-view_z) / focal_x with focal_x = projMatrix[0][0] (same for y).
      const invFocalX: TslNode = float(1).div(this._cameraProjectionMatrix.element(0).element(0));
      const invFocalY: TslNode = float(1).div(this._cameraProjectionMatrix.element(1).element(1));
      const cx: TslNode = threadIndex.mod(NX);
      const cy: TslNode = threadIndex.div(NX).mod(NY);
      const cz: TslNode = threadIndex.div(NX * NY);
      // Y is flipped: cy=0 is the top screen row, NDC y=+1.
      const ndcXmin: TslNode = float(cx)
        .mul(2.0 / NX)
        .sub(1.0);
      const ndcXmax: TslNode = float(cx.add(int(1)))
        .mul(2.0 / NX)
        .sub(1.0);
      const ndcYmax: TslNode = float(1).sub(float(cy).mul(2.0 / NY));
      const ndcYmin: TslNode = float(1).sub(float(cy.add(int(1))).mul(2.0 / NY));
      const farOverNear: TslNode = this._cameraFar.div(this._cameraNear);
      const zNearCluster: TslNode = this._cameraNear
        .mul(pow(farOverNear, float(cz).mul(1.0 / NZ)))
        .negate();
      const zFarCluster: TslNode = this._cameraNear
        .mul(pow(farOverNear, float(cz.add(int(1))).mul(1.0 / NZ)))
        .negate();
      const scaleNearX: TslNode = zNearCluster.negate().mul(invFocalX);
      const scaleFarX: TslNode = zFarCluster.negate().mul(invFocalX);
      const scaleNearY: TslNode = zNearCluster.negate().mul(invFocalY);
      const scaleFarY: TslNode = zFarCluster.negate().mul(invFocalY);
      const xMinNear: TslNode = ndcXmin.mul(scaleNearX);
      const xMaxNear: TslNode = ndcXmax.mul(scaleNearX);
      const xMinFar: TslNode = ndcXmin.mul(scaleFarX);
      const xMaxFar: TslNode = ndcXmax.mul(scaleFarX);
      const yMinNear: TslNode = ndcYmin.mul(scaleNearY);
      const yMaxNear: TslNode = ndcYmax.mul(scaleNearY);
      const yMinFar: TslNode = ndcYmin.mul(scaleFarY);
      const yMaxFar: TslNode = ndcYmax.mul(scaleFarY);
      // AABB of the 8 view-space corners (tile boundaries can straddle the view axis).
      const aabbMin: TslNode = vec3(min(xMinNear, xMinFar), min(yMinNear, yMinFar), zFarCluster);
      const aabbMax: TslNode = vec3(max(xMaxNear, xMaxFar), max(yMaxNear, yMaxFar), zNearCluster);
      Loop(chunksPerCluster, ({ i }) => {
        getClusterChunk(i).assign(ivec4(0));
      });
      const index: TslNode = int(0).toVar();
      // Z-culling: only test lights whose sphere can reach this cluster's slice.
      const zRange: TslNode = textureLoad(zSliceRangesTexture, ivec2(cz, 0));
      const rangeStart = int(zRange.x);
      const rangeEnd = int(zRange.y);
      Loop(this.maxLights, ({ i }) => {
        const lightIdx = rangeStart.add(i);
        If(
          index.greaterThanEqual(int(maxLightsPerCluster)).or(lightIdx.greaterThanEqual(rangeEnd)),
          () => {
            Return();
          },
        );
        const { viewCenter, radius } = this.getLightBound(lightIdx);
        const closest: TslNode = max(aabbMin, min(viewCenter, aabbMax));
        const diff = viewCenter.sub(closest);
        If(dot(diff, diff).lessThanEqual(radius.mul(radius)), () => {
          getClusterSlot(index).assign(lightIdx.add(int(1)));
          index.addAssign(int(1));
        });
      });
    })()
      .compute(clusterCount)
      .setName("Update Clustered Lights");
    // Shading side: fragment → cluster index.
    const getScreenClusterIndex = Fn(() => {
      const screenTile = fragmentCoordinate.div(tileSize).floor();
      const viewDepth = fragmentView.z.negate();
      // Exponential Z slice: floor(log(depth/near) / log(far/near) * NZ).
      const invLogFarOverNear = float(1).div(log(this._cameraFar.div(this._cameraNear)));
      const sliceFloat = log(viewDepth.div(this._cameraNear)).mul(invLogFarOverNear).mul(float(NZ));
      const zSlice = clamp(sliceFloat.floor(), float(0), float(NZ - 1));
      return int(screenTile.x)
        .add(int(screenTile.y).mul(int(NX)))
        .add(int(zSlice).mul(int(NX * NY)));
    });
    this._bufferSize = bufferSize;
    this._lightIndexes = lightIndexes;
    this._screenClusterIndex = getScreenClusterIndex().toVar();
    this._compute = compute;
    this._lightsTexture = lightsTexture;
    this._zSliceRangesTexture = zSliceRangesTexture;
    this._zSliceRangesData = zSliceRangesData;
  }

  override get hasLights(): boolean {
    return super.hasLights || this.clusteredLights.length > 0;
  }
}
