import { useFrame, useThree } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { CameraTarget } from "../domain/camera";

export type { CameraTarget } from "../domain/camera";

const lerpSpeed = 3;

export function CameraAnimator({
  target,
  controlsRef,
  skipInitial = false,
}: {
  target: CameraTarget | null;
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
  skipInitial?: boolean;
}) {
  const { camera } = useThree();
  const cameraGoal = useRef(new THREE.Vector3());
  const lookAtGoal = useRef(new THREE.Vector3());
  const animating = useRef(false);
  const prevKey = useRef<string | null>(
    skipInitial && target
      ? `${target.lookAt.join(",")}_${target.distance ?? 12}_${target.nonce ?? 0}`
      : null,
  );

  useFrame((_, delta) => {
    if (!target) {
      return;
    }

    const dist = target.distance ?? 12;
    const key = `${target.lookAt.join(",")}_${dist}_${target.nonce ?? 0}`;
    if (key !== prevKey.current) {
      prevKey.current = key;
      lookAtGoal.current.set(target.lookAt[0], 0, target.lookAt[2]);
      cameraGoal.current.set(
        target.lookAt[0] + dist * 0.6,
        dist * 0.6,
        target.lookAt[2] + dist * 0.6,
      );
      animating.current = true;
    }

    if (!animating.current) {
      return;
    }

    const t = 1 - Math.exp(-lerpSpeed * delta);
    camera.position.lerp(cameraGoal.current, t);

    if (controlsRef?.current) {
      const ctrl = controlsRef.current;
      ctrl.target.lerp(lookAtGoal.current, t);
      ctrl.update();
    }

    if (camera.position.distanceTo(cameraGoal.current) < 0.05) {
      animating.current = false;
    }
  });

  return null;
}
