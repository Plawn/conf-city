import { useGLTF } from "@react-three/drei";
import { useLayoutEffect, useMemo, useRef } from "react";
import { Color, type Group, Matrix4, type Object3D } from "three";
import { buildingBlastScale } from "../../domain/blast";
import type { BuildingVariant } from "../../domain/buildingVariant";
import { NODE_STYLE } from "../../domain/nodeStyle";
import type { NodeType } from "../../domain/types";
import { REPLAY_MODE, replayPresence } from "../../store/replayStore";
import { BuildingFire } from "../BuildingFire";
import { useBuildingAnimation } from "./BuildingAnimations";
import { useBuildingBatches } from "./BuildingBatches";
import { type BuildingBinding, buildingModel } from "./instances";
import {
  boundsRadius,
  dampFootprint,
  footprintTarget,
  MAP_TINT,
  MaterialAnimation,
  mapTinted,
  type VisualState,
} from "./visuals";

export function InstancedBuilding({
  addr,
  type,
  variant,
  visual,
  fireIntensity,
  position,
  onHover,
  onClick,
}: {
  addr: string;
  type: NodeType;
  variant: BuildingVariant;
  visual: VisualState;
  fireIntensity: number;
  position: readonly number[];
  onHover: (hovered: boolean) => void;
  onClick: () => void;
}) {
  const { scene } = useGLTF(variant.model);
  const model = useMemo(() => buildingModel(scene), [scene]);
  const batches = useBuildingBatches();
  const riseGroup = useRef<Group>(null);
  const sizeGroup = useRef<Group>(null);
  const modelGroup = useRef<Group>(null);
  const interactions = useRef({ onHover, onClick });
  interactions.current = { onHover, onClick };
  const binding = useMemo<BuildingBinding>(
    () => ({
      id: addr,
      matrix: new Matrix4(),
      visual: {
        color: model.textured ? mapTinted(variant.color).clone() : new Color(variant.color),
        emissive: new Color(variant.emissive),
        emissiveIntensity: 0.3,
      },
      hover: (hovered) => interactions.current.onHover(hovered),
      click: () => interactions.current.onClick(),
    }),
    [addr, model, variant],
  );
  const materials = useMemo(() => [binding.visual], [binding]);
  const animation = useMemo(
    () => new MaterialAnimation(variant, model.textured ? MAP_TINT : 0),
    [variant, model.textured],
  );
  const registration = useRef<ReturnType<typeof batches.add> | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new position must move the registration to its new spatial batch.
  useLayoutEffect(() => {
    batchLocal(binding.matrix, modelGroup.current!, batches.group);
    const registered = batches.add(binding, model.parts);
    registration.current = registered;
    return () => {
      registered.remove();
      registration.current = null;
    };
  }, [batches, binding, model, position]);
  const scale = NODE_STYLE[type].scale * variant.fit * variant.scale;
  const { min, max } = model.bounds;
  const targetXZ = footprintTarget(visual, boundsRadius(min, max, scale));
  // Prop changes (including position) wake this task. Only an active transition runs it again.
  useBuildingAnimation(
    (time, delta, night) => {
      const sizeChanged = dampFootprint(sizeGroup.current!.scale, targetXZ, delta);
      if (REPLAY_MODE) {
        riseTo(riseGroup.current!, addr);
      }
      batchLocal(SCRATCH, modelGroup.current!, batches.group);
      const transformChanged = !binding.matrix.equals(SCRATCH);
      if (transformChanged) {
        binding.matrix.copy(SCRATCH);
      }
      const result = animation.advance(materials, visual, night, time, delta);
      if (transformChanged || result.changed) {
        registration.current?.write(transformChanged, result.changed);
      }
      // A replay moves buildings with the scenario clock (and the island under them): never sleep.
      return REPLAY_MODE || sizeChanged || result.active;
    },
    [animation, materials, visual, targetXZ, binding, position, addr],
    true,
  );

  return (
    <group ref={riseGroup}>
      <group ref={sizeGroup}>
        <group ref={modelGroup} scale={scale} rotation-y={variant.yaw} />
        {fireIntensity > 0 && (
          <group rotation-y={variant.yaw}>
            <BuildingFire
              seed={addr}
              roof={[((min.x + max.x) * scale) / 2, max.y * scale, ((min.z + max.z) * scale) / 2]}
              width={(max.x - min.x) * scale}
              depth={(max.z - min.z) * scale}
              intensity={fireIntensity}
            />
          </group>
        )}
      </group>
    </group>
  );
}

/** Replay: grows from the ground, slightly narrow until done; swells and vanishes when it blows up. */
function riseTo(group: Group, addr: string) {
  const blast = replayPresence.blasts.get(addr);
  if (blast !== undefined) {
    const [xz, y] = buildingBlastScale(blast);
    group.scale.set(Math.max(0.001, xz), Math.max(0.001, y), Math.max(0.001, xz));
    return;
  }
  const presence = replayPresence.nodes.get(addr) ?? 0;
  const up = 1 - (1 - presence) ** 3;
  const xz = 0.6 + 0.4 * presence;
  group.scale.set(xz, Math.max(0.001, up), xz);
}

const SCRATCH = new Matrix4();

/** `object`'s transform in the batch group's space: the batch is drawn inside the city's (lifted) group. */
function batchLocal(out: Matrix4, object: Object3D, root: Object3D) {
  object.updateWorldMatrix(true, false);
  root.updateWorldMatrix(true, false);
  return out.copy(root.matrixWorld).invert().multiply(object.matrixWorld);
}
