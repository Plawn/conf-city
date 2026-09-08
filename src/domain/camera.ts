export interface CameraTarget {
  lookAt: [number, number, number];
  /** How far the camera should sit from the target. */
  distance?: number;
  /** Bump to re-trigger an animation toward an identical target. */
  nonce?: number;
}
