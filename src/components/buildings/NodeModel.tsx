import { useGLTF } from "@react-three/drei";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { BuildingVariant } from "../../domain/buildingVariant";
import { NODE_STYLE, PORT_ASSETS } from "../../domain/nodeStyle";
import type { NodeType } from "../../domain/types";
import { BuildingFire } from "../BuildingFire";
import { useBuildingAnimation } from "./BuildingAnimations";
import { harbourGeometry } from "./harbourGeometry";
import {
  boundsRadius,
  dampFootprint,
  footprintTarget,
  MAP_TINT,
  MaterialAnimation,
  mapTinted,
  PORT_TINT,
  type VisualState,
} from "./visuals";

// Preload every model a variant may pick
for (const config of Object.values(NODE_STYLE)) {
  for (const m of config.models) {
    useGLTF.preload(m.path);
  }
}

function useMaterialVisuals(
  materials: THREE.MeshStandardMaterial[],
  fade: number,
  variant: BuildingVariant,
  visualRef: { current: VisualState },
) {
  const animation = useMemo(() => new MaterialAnimation(variant, fade), [variant, fade]);
  useBuildingAnimation(
    (time, delta, night) =>
      animation.advance(materials, visualRef.current, night, time, delta).active,
    [animation, materials, visualRef.current],
    true,
  );
}

/**
 * Footprint of the quay, in world units: the model is authored ~1.5 wide, and a
 * lattice cell is `PITCH` (6). Big enough to read as a port from the city's own
 * camera distance, small enough that two berths a couple of cells apart do not
 * overlap.
 */
export const PORT_SCALE = 2.6;

/**
 * The port an ingress service *is*, in place of a building.
 *
 * Two things separate it from `NodeModel`: the yaw is **imposed** by the berth's
 * bearing (the quay has to face the sea; a seeded k·π/2 turn would put the
 * cranes over the fields), and the height is **frozen** — a quay does not grow
 * with the service's memory. Everything else — the tint, the CPU glow, the error
 * flash, the hover and selection highlight — is the same drive as every other
 * node, so a port reads at a glance like the service it is.
 */
export function PortModel({
  bearing,
  variant,
  visual,
  isDiscovered,
}: {
  bearing: number;
  variant: BuildingVariant;
  visual: VisualState;
  isDiscovered?: boolean;
}) {
  const visualRef = useRef(visual);
  visualRef.current = visual;

  // `PORT_ASSETS.harbour` is null until the real GLB lands, and hooks cannot be
  // called conditionally — so drei is handed a model we know exists and its
  // scene is ignored, the quay coming from `harbourGeometry()` instead.
  const glb = PORT_ASSETS.harbour;
  const { scene } = useGLTF(glb ?? NODE_STYLE.app.modelPath);

  // `glb` is a module constant (`PORT_ASSETS.harbour`), so it is not a dependency:
  // swapping it means a reload, and the two branches below are picked once.
  const { object, materials, geometry } = useMemo(() => {
    const materials: THREE.MeshStandardMaterial[] = [];
    const paint = (map: THREE.Texture | null, vertexColors: boolean) => {
      const mat = new THREE.MeshStandardMaterial({
        map,
        vertexColors,
        color: mapTinted(variant.color, PORT_TINT),
        emissive: variant.emissive,
        emissiveIntensity: 0.3,
        metalness: 0.1,
        roughness: 0.7,
        transparent: !!isDiscovered,
        opacity: isDiscovered ? 0.75 : 1,
      });
      materials.push(mat);
      return mat;
    };
    if (!glb) {
      const geometry = harbourGeometry();
      const mesh = new THREE.Mesh(geometry, paint(null, true));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      return { object: mesh, materials, geometry };
    }
    const clone = scene.clone(true);
    clone.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        const src = (Array.isArray(child.material) ? child.material[0] : child.material) as
          | THREE.MeshStandardMaterial
          | undefined;
        child.material = paint(src?.map ?? null, child.geometry.hasAttribute("color"));
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    return { object: clone, materials, geometry: null };
  }, [scene, variant, isDiscovered]);

  useEffect(() => {
    return () => {
      geometry?.dispose();
      for (const m of materials) {
        m.dispose();
      }
    };
  }, [geometry, materials]);

  useMaterialVisuals(materials, PORT_TINT, variant, visualRef);

  return <primitive object={object} scale={PORT_SCALE} rotation-y={bearing} />;
}

export function NodeModel({
  addr,
  type,
  variant,
  visual,
  isDiscovered,
  fireIntensity,
}: {
  addr: string;
  type: NodeType;
  variant: BuildingVariant;
  visual: VisualState;
  isDiscovered?: boolean;
  fireIntensity: number;
}) {
  const config = NODE_STYLE[type];
  const { scene } = useGLTF(variant.model);
  const visualRef = useRef(visual);
  visualRef.current = visual;
  const scaleGroup = useRef<THREE.Group>(null);
  const fireBounds = useMemo(() => {
    const bounds = new THREE.Box3().setFromObject(scene);
    const s = config.scale * variant.fit * variant.scale;
    return {
      roof: [
        ((bounds.min.x + bounds.max.x) * s) / 2,
        bounds.max.y * s,
        ((bounds.min.z + bounds.max.z) * s) / 2,
      ] as [number, number, number],
      width: (bounds.max.x - bounds.min.x) * s,
      depth: (bounds.max.z - bounds.min.z) * s,
      radius: boundsRadius(bounds.min, bounds.max, s),
    };
  }, [scene, config.scale, variant.fit, variant.scale]);
  const { radius: modelRadius, ...fire } = fireBounds;

  // Clone the GLTF once; all per-frame visuals are driven imperatively below.
  // The material is rebuilt rather than reused (every visual below is written
  // imperatively, and `scene` is the shared cached GLTF), but the maps the loader
  // resolved are carried over — they are what the building's detail is made of.
  const { clonedScene, materials, textured } = useMemo(() => {
    const clone = scene.clone(true);
    const materials: THREE.MeshStandardMaterial[] = [];
    let textured = false;
    clone.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        const src = (Array.isArray(child.material) ? child.material[0] : child.material) as
          | THREE.MeshStandardMaterial
          | undefined;
        const map = src?.map ?? null;
        if (map) {
          textured = true;
        }
        const mat = new THREE.MeshStandardMaterial({
          map,
          normalMap: src?.normalMap ?? null,
          vertexColors: child.geometry.hasAttribute("color"),
          color: map ? mapTinted(variant.color) : variant.color,
          emissive: variant.emissive,
          emissiveIntensity: 0.3,
          // A building is masonry, glass and painted steel — not a mirror. The old
          // 0.3 metalness read as grey plastic under a fill-only light and turns
          // openly wrong now that there is an environment to reflect.
          metalness: 0.08,
          roughness: 0.72,
          transparent: !!isDiscovered,
          opacity: isDiscovered ? 0.75 : 1,
        });
        child.material = mat;
        child.castShadow = true;
        child.receiveShadow = true;
        materials.push(mat);
      }
    });
    return { clonedScene: clone, materials, textured };
  }, [scene, variant, isDiscovered]);

  useEffect(() => {
    return () => {
      for (const m of materials) {
        m.dispose();
      }
    };
  }, [materials]);

  useMaterialVisuals(materials, textured ? MAP_TINT : 0, variant, visualRef);

  const targetXZ = footprintTarget(visual, modelRadius);
  useBuildingAnimation(
    (_, delta) => {
      const group = scaleGroup.current;
      if (!group) {
        return false;
      }
      return dampFootprint(group.scale, targetXZ, delta);
    },
    [targetXZ],
  );

  // Footprint (memory) lives on the parent group; the variant's turn and size sit
  // on the model itself, under it, so the two never fight.
  return (
    <group ref={scaleGroup}>
      <primitive
        object={clonedScene}
        scale={config.scale * variant.fit * variant.scale}
        rotation-y={variant.yaw}
      />
      {fireIntensity > 0 && (
        <group rotation-y={variant.yaw}>
          <BuildingFire seed={addr} {...fire} intensity={fireIntensity} />
        </group>
      )}
    </group>
  );
}
