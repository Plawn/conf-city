import { useEffect, useMemo } from "react";
import * as THREE from "three";
import {
  PLATFORM_SPREAD,
  PLATFORM_TOP,
  STREET_Y,
  type StationAccess,
} from "../../sim/mobility/station";
import { buildRibbon } from "../geo/ribbon";
import { SceneLabel } from "../SceneLabel";

/** Every mesh comes from the same `StationAccess` the passengers walk. */
export function MetroStation({ access }: { access: StationAccess }) {
  const stairs = useMemo(
    () => buildRibbon([access.stairFoot, access.stairTop], 0.8),
    [access.stairFoot, access.stairTop],
  );
  const landing = useMemo(
    () => buildRibbon([access.stairTop, access.door], 0.8),
    [access.stairTop, access.door],
  );
  useEffect(() => {
    return () => {
      stairs.dispose();
      landing.dispose();
    };
  }, [stairs, landing]);
  const yaw = Math.atan2(access.alongX, access.alongZ);
  return (
    <group>
      <mesh position={[access.track[0], PLATFORM_TOP / 2, access.track[2]]}>
        <cylinderGeometry args={[0.1, 0.15, PLATFORM_TOP, 6]} />
        <meshStandardMaterial color="#64748b" />
      </mesh>
      <mesh position={access.door} rotation={[0, yaw, 0]}>
        <boxGeometry args={[0.5, 0.12, PLATFORM_SPREAD + 0.6]} />
        <meshStandardMaterial color="#37cbb2" />
      </mesh>
      <mesh geometry={stairs}>
        <meshStandardMaterial color="#64748b" side={THREE.DoubleSide} />
      </mesh>
      <mesh geometry={landing}>
        <meshStandardMaterial color="#64748b" side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[access.stairFoot[0], STREET_Y + 0.6, access.stairFoot[2]]}>
        <boxGeometry args={[0.5, 1.2, 0.5]} />
        <meshStandardMaterial color="#408b8e" transparent opacity={0.55} />
      </mesh>
      <SceneLabel position={[access.door[0], access.door[1] + 0.55, access.door[2]]}>
        <span className="rounded bg-emerald-950/90 px-1.5 text-[10px] font-bold text-emerald-200">
          M{access.index + 1}
        </span>
      </SceneLabel>
    </group>
  );
}
