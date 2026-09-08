import { useGLTF } from "@react-three/drei";
import { useLayoutEffect, useMemo, useRef } from "react";
import { Color, type Group, MathUtils, Matrix4 } from "three";
import type { BuildingVariant } from "../../domain/buildingVariant";
import { NODE_STYLE } from "../../domain/nodeStyle";
import type { NodeType } from "../../domain/types";
import { BuildingFire } from "../BuildingFire";
import { useBuildingAnimation } from "./BuildingAnimations";
import { useBuildingBatches } from "./BuildingBatches";
import { type BuildingBinding, buildingModel } from "./instances";
import { heightTarget, MAP_TINT, MaterialAnimation, mapTinted, type VisualState } from "./visuals";

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
  const heightGroup = useRef<Group>(null);
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
    modelGroup.current!.updateWorldMatrix(true, false);
    binding.matrix.copy(modelGroup.current!.matrixWorld);
    const registered = batches.add(binding, model.parts);
    registration.current = registered;
    return () => {
      registered.remove();
      registration.current = null;
    };
  }, [batches, binding, model, position]);
  const targetY = heightTarget(type, visual);
  // Prop changes (including position) wake this task. Only an active transition runs it again.
  useBuildingAnimation(
    (time, delta, night) => {
      const group = heightGroup.current!;
      const heightChanged = Math.abs(group.scale.y - targetY) > 1e-3;
      if (heightChanged) {
        group.scale.y = MathUtils.damp(group.scale.y, targetY, 4, delta);
      }
      modelGroup.current!.updateWorldMatrix(true, false);
      const transformChanged = !binding.matrix.equals(modelGroup.current!.matrixWorld);
      if (transformChanged) {
        binding.matrix.copy(modelGroup.current!.matrixWorld);
      }
      const result = animation.advance(materials, visual, night, time, delta);
      if (transformChanged || result.changed) {
        registration.current?.write(transformChanged, result.changed);
      }
      return heightChanged || result.active;
    },
    [animation, materials, visual, targetY, binding, position],
    true,
  );

  const scale = NODE_STYLE[type].scale * variant.fit * variant.scale;
  const { min, max } = model.bounds;
  return (
    <group ref={heightGroup}>
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
  );
}
