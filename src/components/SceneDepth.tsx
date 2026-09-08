import { useFrame, useThree } from "@react-three/fiber";
import type { MutableRefObject } from "react";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";

/**
 * Keeps the depth cues — fog band and camera far plane — tied to *what the user
 * is looking at* rather than to the size of the world.
 *
 * A fog fixed in world units cannot work under an orbit camera whose distance
 * spans two orders of magnitude: tuned for the default framing it never fires,
 * and one "fit all" later the whole scene sits past the far end and dissolves
 * into the background. So the band is anchored on the orbit target instead —
 * fog starts at the distance of the thing in focus, which therefore always
 * renders crisp, and fades whatever stands *behind* it. Zooming in on one city
 * hazes the others; pulling back keeps the archipelago readable and only eats
 * the empty sea beyond it.
 *
 * The far plane follows the same number, so geometry never gets clipped before
 * the fog has finished hiding it.
 */

/** Fog starts exactly at the orbit target — the focus is never hazed. */
const FOG_START = 1;
/** Depth of the band, as a multiple of the larger of the view distance and the world. */
const FOG_REACH = 1.6;
/** Beyond the fog, enough room that nothing pops at the far plane. */
const FAR_MARGIN = 1.4;
/** Recompute the projection matrix only when the far plane really moved. */
const FAR_EPSILON = 1;

export function SceneDepth({
  extent,
  controlsRef,
  waterRadius,
}: {
  /** Half-size of the built world, from `WorldScene`. */
  extent: number;
  controlsRef: MutableRefObject<OrbitControlsImpl | null>;
  /** The fog must be opaque before the sea runs out, or its edge shows as a horizon. */
  waterRadius: number;
}) {
  const { scene, camera } = useThree();

  useFrame(() => {
    const fog = scene.fog;
    if (!(fog instanceof THREE.Fog)) {
      return;
    }

    const target = controlsRef.current?.target;
    const distance = target ? camera.position.distanceTo(target) : camera.position.length();
    const near = distance * FOG_START;
    const far = Math.min(near + Math.max(extent, distance) * FOG_REACH, waterRadius);

    fog.near = near;
    // A degenerate band (a world smaller than the camera is close) would make the
    // fog a step function: keep a floor of one view distance.
    fog.far = Math.max(far, near + distance);

    const wanted = fog.far * FAR_MARGIN;
    if (Math.abs(camera.far - wanted) > FAR_EPSILON) {
      camera.far = wanted;
      camera.updateProjectionMatrix();
    }
  });

  return null;
}
