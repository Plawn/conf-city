import { useEffect, useId, useMemo, useRef } from "react";
import * as THREE from "three";
import { float, smoothstep, uniform, uv } from "three/tsl";
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from "three/webgpu";
import { TERRAIN } from "../domain/nodeStyle";
import type { Roundabout } from "../layout/types";
import type { Run } from "./geo/roadGraph";
import { CLASS_STYLE, ISLAND_HEIGHT, PAVEMENT, ringRadii } from "./geo/roadStyle";
import { createLightSource, useLighting } from "./lighting/runtime";

/**
 * Street lighting on the busy roads only — avenues, boulevards and the centre of
 * every roundabout. Instanced poles, emissive bulbs and faint soft ground pools
 * accompany real point lights allocated by the shared local-light manager.
 *
 * Lamps stand in the middle of the pavement, placed along the run rather than
 * at its ends and alternating sides, so a long boulevard reads as a lit axis
 * from above without the poles queuing up at the junctions where the
 * roundabout lamp already sits. The ring road is an avenue, so it is lit too.
 */

const SPACING = 7;
const POLE_HEIGHT = 1.5;
const POLE_RADIUS = 0.055;
const BULB_RADIUS = 0.13;
const POOL_RADIUS = 1.5;
const POOL_Y = TERRAIN.roadY + 0.02;

export function StreetLights({ runs, roundabouts }: { runs: Run[]; roundabouts: Roundabout[] }) {
  const lighting = useLighting();
  const prefix = useId();
  const materials = useMemo(() => {
    const bulbs = new MeshStandardNodeMaterial({ color: "#514530", roughness: 0.3 });
    bulbs.emissiveNode = uniform(new THREE.Color(TERRAIN.lampLight)).mul(lighting.night.mul(3));
    const pools = new MeshBasicNodeMaterial({
      color: TERRAIN.lampLight,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    pools.opacityNode = float(1)
      .sub(smoothstep(0.08, 0.5, uv().sub(0.5).length()))
      .mul(lighting.night)
      .mul(0.06);
    return { bulbs, pools };
  }, [lighting]);
  useEffect(
    () => () => {
      materials.bulbs.dispose();
      materials.pools.dispose();
    },
    [materials],
  );
  const lamps = useMemo(() => {
    /** `[x, z, baseY]` — on the pavement, or on top of a roundabout's planted island. */
    const out: [number, number, number][] = [];

    for (const s of runs) {
      if (!CLASS_STYLE[s.klass].lit) {
        continue;
      }
      const offset = s.halfWidth + PAVEMENT / 2;
      // Walk the polyline by arc length, one lamp every SPACING, sides alternating.
      let total = 0;
      for (let k = 0; k + 1 < s.points.length; k++) {
        const a = s.points[k]!;
        const b = s.points[k + 1]!;
        total += Math.hypot(b[0] - a[0], b[1] - a[1]);
      }
      const count = Math.floor(total / SPACING);
      if (count < 1) {
        continue;
      }
      // Centre the row on the run, so both ends keep an equal dark margin.
      let next = (total - (count - 1) * SPACING) / 2;
      let i = 0;
      let walked = 0;
      for (let k = 0; k + 1 < s.points.length && i < count; k++) {
        const a = s.points[k]!;
        const b = s.points[k + 1]!;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len === 0) {
          continue;
        }
        const ux = (b[0] - a[0]) / len;
        const uz = (b[1] - a[1]) / len;
        while (i < count && next <= walked + len + 1e-9) {
          const t = next - walked;
          const side = i % 2 === 0 ? offset : -offset;
          // Perpendicular, on the ground plane — same convention as `buildRibbon`.
          out.push([a[0] + ux * t + uz * side, a[1] + uz * t - ux * side, TERRAIN.pavementY]);
          i++;
          next += SPACING;
        }
        walked += len;
      }
    }

    // One lamp planted in the middle of each roundabout island.
    for (const r of roundabouts) {
      if (ringRadii(r).inner > 0) {
        out.push([r.center[0], r.center[1], TERRAIN.roadY + ISLAND_HEIGHT]);
      }
    }
    return out;
  }, [runs, roundabouts]);

  useEffect(() => {
    const sources = lamps.map(([x, z, baseY], i) => {
      const source = createLightSource(`${prefix}:street:${i}`, "street");
      source.position.set(x, baseY + POLE_HEIGHT, z);
      source.intensity = 8;
      source.range = 4.5;
      lighting.sources.set(source.id, source);
      return source;
    });
    return () => {
      for (const source of sources) {
        lighting.sources.delete(source.id);
      }
    };
  }, [lamps, lighting, prefix]);

  const poles = useRef<THREE.InstancedMesh>(null);
  const bulbs = useRef<THREE.InstancedMesh>(null);
  const pools = useRef<THREE.InstancedMesh>(null);

  useEffect(() => {
    const m = new THREE.Matrix4();
    lamps.forEach(([x, z, baseY], i) => {
      m.makeTranslation(x, baseY + POLE_HEIGHT / 2, z);
      poles.current?.setMatrixAt(i, m);
      m.makeTranslation(x, baseY + POLE_HEIGHT + BULB_RADIUS * 0.6, z);
      bulbs.current?.setMatrixAt(i, m);
      // The pool lies flat on the tarmac: the disc is authored in XY, so the
      // rotation has to live in the instance matrix, not on the parent mesh.
      m.makeRotationX(-Math.PI / 2);
      m.setPosition(x, POOL_Y, z);
      pools.current?.setMatrixAt(i, m);
    });
    for (const ref of [poles, bulbs, pools]) {
      if (ref.current) {
        ref.current.instanceMatrix.needsUpdate = true;
      }
    }
  }, [lamps]);

  if (lamps.length === 0) {
    return null;
  }

  return (
    <group>
      <instancedMesh
        ref={poles}
        args={[undefined, undefined, lamps.length]}
        castShadow
        frustumCulled={false}
      >
        <cylinderGeometry args={[POLE_RADIUS, POLE_RADIUS * 1.4, POLE_HEIGHT, 6]} />
        <meshStandardMaterial color={TERRAIN.lampPole} roughness={0.8} metalness={0.2} />
      </instancedMesh>

      <instancedMesh
        ref={bulbs}
        args={[undefined, materials.bulbs, lamps.length]}
        frustumCulled={false}
      >
        <sphereGeometry args={[BULB_RADIUS, 8, 6]} />
        {/* Unlit and out of tone mapping: this is the emitter the bloom pass looks for. */}
      </instancedMesh>

      {/* The pool of light: additive, so it brightens the tarmac without hiding
          the lane markings just below it, and never writes depth. */}
      <instancedMesh
        ref={pools}
        args={[undefined, materials.pools, lamps.length]}
        frustumCulled={false}
        renderOrder={2}
      >
        <circleGeometry args={[POOL_RADIUS, 16]} />
      </instancedMesh>
    </group>
  );
}
