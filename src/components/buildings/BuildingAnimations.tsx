import { useFrame } from "@react-three/fiber";
import {
  createContext,
  type DependencyList,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { useLighting } from "../lighting/runtime";
import { AnimationQueue, type AnimationStep } from "./animationQueue";

const Context = createContext<AnimationQueue | null>(null);

export function BuildingAnimations({ children }: { children: ReactNode }) {
  const queue = useMemo(() => new AnimationQueue(), []);
  const lighting = useLighting();
  useFrame(({ clock }, delta) => {
    queue.advance(clock.elapsedTime, delta, lighting.night.value);
    lighting.frameWork.buildingAnimationVisits = queue.visits;
    lighting.frameWork.buildingInstanceWrites = 0;
  }, -20);
  return <Context.Provider value={queue}>{children}</Context.Provider>;
}

export function useBuildingAnimation(
  step: AnimationStep,
  dependencies: DependencyList,
  nightSensitive = false,
) {
  const queue = useContext(Context);
  if (!queue) {
    throw new Error("BuildingAnimations missing");
  }
  const latest = useRef(step);
  latest.current = step;
  // Inputs explicitly wake sleeping tasks, without replacing the scene's frame subscriber.
  useLayoutEffect(
    () => queue.add((...args) => latest.current(...args), nightSensitive),
    [queue, nightSensitive, ...dependencies],
  );
}
