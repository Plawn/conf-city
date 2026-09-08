import { type ThreeEvent, useFrame } from "@react-three/fiber";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { useLighting } from "../lighting/runtime";
import { BuildingBatch, BuildingInstances } from "./instances";

const Context = createContext<BuildingInstances | null>(null);

export function BuildingBatches({ children }: { children: ReactNode }) {
  const instances = useMemo(() => new BuildingInstances(), []);
  const lighting = useLighting();
  useFrame(() => {
    lighting.frameWork.buildingInstanceWrites += instances.flush();
  }, -15);
  const binding = (event: ThreeEvent<PointerEvent | MouseEvent>) => {
    const batch = event.object.userData.buildingBatch;
    return batch instanceof BuildingBatch ? batch.slots[event.instanceId ?? 0]?.binding : undefined;
  };
  return (
    <Context.Provider value={instances}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: R3F scene group. */}
      <group
        onPointerMove={(event) => {
          const target = binding(event);
          if (target) {
            event.stopPropagation();
            instances.hover(target);
          }
        }}
        onPointerOut={() => instances.hover(null)}
        onClick={(event) => {
          const target = binding(event);
          if (target) {
            event.stopPropagation();
            target.click();
          }
        }}
      >
        <primitive object={instances.group} />
        {children}
      </group>
    </Context.Provider>
  );
}

export function useBuildingBatches() {
  const batches = useContext(Context);
  if (!batches) {
    throw new Error("BuildingBatches missing");
  }
  return batches;
}
