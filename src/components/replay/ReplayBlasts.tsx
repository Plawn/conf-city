import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import {
  BLAST_SEC,
  blastPuffs,
  blastShards,
  fireballAt,
  type Puff,
  puffAt,
  type Shard,
  shardAt,
} from "../../domain/blast";
import { NODE_STYLE } from "../../domain/nodeStyle";
import { cityLift } from "../../domain/replayLift";
import { DUST_SEC, type DustPuff, dustAt, dustPuffs } from "../../domain/replayRise";
import type { PositionedNode } from "../../domain/types";
import type { WorldLayout } from "../../layout/types";
import { replayPresence } from "../../store/replayStore";
import { NO_RAYCAST } from "../three/instancing";

/** Simultaneous blasts drawn; more are skipped (a migration can retire a whole island at once). */
const MAX_BLASTS = 64;
const SHARDS = 26;
const FLAMES = 6;
const PUFFS = 9;
const DUSTS = 8;
const SMOKE = new THREE.Color("#3e3a3c");
const DUST = new THREE.Color("#7a7062");
const DEBRIS = ["#5a5856", "#6e6a64", "#47464a", "#7a6a58"];
const HOT = new THREE.Color("#ffe39a").multiplyScalar(3.2);
const WARM = new THREE.Color("#ff6a1a").multiplyScalar(1.8);
const COOL = new THREE.Color("#3a2a24");

interface Site {
  x: number;
  /** Deck the building stood on. */
  y: number;
  z: number;
  cityId: string;
  cloud: boolean;
  /** Building height and footprint, from its type's reference scale. */
  height: number;
  width: number;
  shards: Shard[];
  puffs: Puff[];
  dust: DustPuff[];
}

/**
 * Buildings leaving the replay explode (fireball, flying debris, smoke); arriving ones kick up
 * a ring of dust. Three pooled draws: dust shares the smoke pool.
 */
export function ReplayBlasts({ layout, rampSec }: { layout: WorldLayout; rampSec: number }) {
  const shardMesh = useRef<THREE.InstancedMesh>(null);
  const fireMesh = useRef<THREE.InstancedMesh>(null);
  const smokeMesh = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const color = useMemo(() => new THREE.Color(), []);
  const shard = useMemo(() => ({ x: 0, y: 0, z: 0, roll: 0, scale: 0 }), []);
  const puff = useMemo(() => ({ x: 0, y: 0, z: 0, scale: 0 }), []);
  const smokePool = MAX_BLASTS * PUFFS;
  const sites = useMemo(() => new Map<string, Site>(), []);
  const byAddr = useMemo(
    () => new Map(layout.nodes.map((n) => [`${n.cityId}/${n.id}`, n] as const)),
    [layout.nodes],
  );

  useLayoutEffect(() => {
    const mesh = shardMesh.current!;
    for (let i = 0; i < MAX_BLASTS * SHARDS; i++) {
      mesh.setColorAt(i, color.set(DEBRIS[i % DEBRIS.length]!));
    }
    mesh.instanceColor!.needsUpdate = true;
    // Allocate smoke colours up front: the material compiles once, with instance colours.
    for (let i = 0; i < smokePool; i++) {
      smokeMesh.current!.setColorAt(i, SMOKE);
    }
    for (const m of [shardMesh, fireMesh, smokeMesh]) {
      m.current!.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.current!.count = 0;
    }
  }, [color, smokePool]);

  useFrame(() => {
    let blasts = 0;
    let shards = 0;
    let flames = 0;
    let puffs = 0;
    for (const [addr, age] of replayPresence.blasts) {
      if (blasts >= MAX_BLASTS || age >= BLAST_SEC) {
        continue;
      }
      const site = siteOf(sites, byAddr, layout, addr);
      if (!site) {
        continue;
      }
      blasts++;
      const y = site.y + cityLift(replayPresence.cities.get(site.cityId) ?? 0, site.cloud);
      for (const s of site.shards) {
        shardAt(s, age, site.width, site.height, shard);
        dummy.position.set(site.x + shard.x, y + shard.y, site.z + shard.z);
        dummy.rotation.set(shard.roll, shard.roll * 0.7, shard.roll * 0.3);
        dummy.scale.setScalar(Math.max(0.0001, shard.scale));
        dummy.updateMatrix();
        shardMesh.current!.setMatrixAt(shards++, dummy.matrix);
      }
      const fire = fireballAt(age);
      if (fire.radius > 0) {
        const size = Math.max(site.width, site.height * 0.6);
        // Hot white core → orange → soot.
        color
          .copy(fire.heat > 0.6 ? HOT : WARM)
          .lerp(fire.heat > 0.6 ? WARM : COOL, fireMix(fire.heat));
        for (let i = 0; i < FLAMES; i++) {
          const a = (i / FLAMES) * Math.PI * 2;
          const r = i === 0 ? 0 : 0.35 * size * fire.radius;
          dummy.position.set(
            site.x + Math.cos(a) * r,
            y + site.height * 0.45 + (i === 0 ? 0 : 0.25 * size * (i % 2)),
            site.z + Math.sin(a) * r,
          );
          dummy.rotation.set(a, a * 0.5, 0);
          dummy.scale.setScalar(size * fire.radius * (i === 0 ? 0.9 : 0.6));
          dummy.updateMatrix();
          fireMesh.current!.setMatrixAt(flames, dummy.matrix);
          fireMesh.current!.setColorAt(flames++, color);
        }
      }
      const size = Math.max(site.width, site.height * 0.5);
      for (const p of site.puffs) {
        puffAt(p, age, puff);
        smokeMesh.current!.setColorAt(puffs, SMOKE);
        dummy.position.set(site.x + puff.x * size, y + puff.y * size, site.z + puff.z * size);
        dummy.rotation.set(p.angle, p.delay * 9, 0);
        dummy.scale.setScalar(Math.max(0.0001, puff.scale * size));
        dummy.updateMatrix();
        smokeMesh.current!.setMatrixAt(puffs++, dummy.matrix);
      }
    }
    // Construction dust while a building rises (its age is presence × ramp).
    for (const [addr, presence] of replayPresence.nodes) {
      const age = presence * rampSec;
      if (presence >= 1 || age >= DUST_SEC || replayPresence.blasts.has(addr)) {
        continue;
      }
      if (puffs + DUSTS > smokePool) {
        break;
      }
      const site = siteOf(sites, byAddr, layout, addr);
      if (!site) {
        continue;
      }
      const y = site.y + cityLift(replayPresence.cities.get(site.cityId) ?? 0, site.cloud);
      const size = site.width * 1.4;
      for (const p of site.dust) {
        dustAt(p, age, puff);
        if (puff.scale <= 0) {
          continue;
        }
        dummy.position.set(site.x + puff.x * size, y + puff.y * size, site.z + puff.z * size);
        dummy.rotation.set(p.angle, p.angle * 0.5, 0);
        dummy.scale.setScalar(puff.scale * size);
        dummy.updateMatrix();
        smokeMesh.current!.setMatrixAt(puffs, dummy.matrix);
        smokeMesh.current!.setColorAt(puffs++, DUST);
      }
    }
    for (const [mesh, count] of [
      [shardMesh.current!, shards],
      [fireMesh.current!, flames],
      [smokeMesh.current!, puffs],
    ] as const) {
      mesh.count = count;
      mesh.visible = count > 0;
      if (count > 0) {
        // Upload only the live instances, not the whole pool.
        mesh.instanceMatrix.clearUpdateRanges();
        mesh.instanceMatrix.addUpdateRange(0, count * 16);
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor && mesh !== shardMesh.current) {
          mesh.instanceColor.clearUpdateRanges();
          mesh.instanceColor.addUpdateRange(0, count * 3);
          mesh.instanceColor.needsUpdate = true;
        }
      }
    }
  }, -10);

  return (
    <group name="replay-blasts">
      <instancedMesh
        ref={shardMesh}
        args={[undefined, undefined, MAX_BLASTS * SHARDS]}
        frustumCulled={false}
        raycast={NO_RAYCAST}
        castShadow
      >
        <boxGeometry args={[1, 0.6, 0.8]} />
        <meshStandardMaterial roughness={0.9} />
      </instancedMesh>
      <instancedMesh
        ref={fireMesh}
        args={[undefined, undefined, MAX_BLASTS * FLAMES]}
        frustumCulled={false}
        raycast={NO_RAYCAST}
      >
        <icosahedronGeometry args={[1, 2]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <instancedMesh
        ref={smokeMesh}
        args={[undefined, undefined, MAX_BLASTS * PUFFS]}
        frustumCulled={false}
        raycast={NO_RAYCAST}
      >
        <icosahedronGeometry args={[1, 1]} />
        <meshBasicMaterial transparent opacity={0.55} depthWrite={false} />
      </instancedMesh>
    </group>
  );
}

function fireMix(heat: number) {
  return heat > 0.6 ? (1 - heat) / 0.4 : 1 - heat / 0.6;
}

function siteOf(
  sites: Map<string, Site>,
  byAddr: Map<string, PositionedNode>,
  layout: WorldLayout,
  addr: string,
): Site | undefined {
  let site = sites.get(addr);
  if (!site) {
    const node = byAddr.get(addr);
    if (!node) {
      return undefined;
    }
    const scale = NODE_STYLE[node.type].scale;
    site = {
      x: node.position[0],
      y: node.position[1],
      z: node.position[2],
      cityId: node.cityId,
      cloud: layout.cities.get(node.cityId)?.cloud === true,
      height: scale * 1.4,
      width: scale * 0.8,
      shards: blastShards(addr, SHARDS),
      puffs: blastPuffs(addr, PUFFS),
      dust: dustPuffs(addr, DUSTS),
    };
    sites.set(addr, site);
  }
  return site;
}
