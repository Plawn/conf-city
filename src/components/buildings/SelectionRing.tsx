import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";

// Shared like gauge geometry: selecting a node must not create a new GPU pipeline.
const SELECTION_GEOMETRY = new Map<number, THREE.RingGeometry>();
const SELECTION_MATERIAL = new THREE.MeshBasicMaterial({
  color: "#9dc0ff",
  toneMapped: false,
  transparent: true,
  opacity: 0.9,
  side: THREE.DoubleSide,
  depthWrite: false,
  polygonOffset: true,
  polygonOffsetFactor: -6,
  polygonOffsetUnits: -6,
});

export function SelectionRing({ radius }: { radius: number }) {
  const ref = useRef<THREE.Mesh>(null);
  let geometry = SELECTION_GEOMETRY.get(radius);
  if (!geometry) {
    geometry = new THREE.RingGeometry(radius, radius + 0.1, 48, 1, 0, Math.PI * 1.7);
    SELECTION_GEOMETRY.set(radius, geometry);
  }
  useFrame((state) => {
    if (!ref.current) {
      return;
    }
    ref.current.rotation.z = state.clock.elapsedTime * 0.8;
    const s = 1 + 0.04 * Math.sin(state.clock.elapsedTime * 3);
    ref.current.scale.setScalar(s);
  });
  return (
    <mesh
      ref={ref}
      rotation-x={-Math.PI / 2}
      position-y={0.09}
      renderOrder={4}
      geometry={geometry}
      material={SELECTION_MATERIAL}
      dispose={null}
    />
  );
}
