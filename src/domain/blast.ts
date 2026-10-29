import { fnv1a, mulberry32 } from "../lib/random";

/** Replay demolition: a pure function of the seconds since the building left (`age`). */
export const BLAST_SEC = 2.6;
/** The building swells this long, then shatters. */
export const BLAST_POP = 0.14;
/** Island sinks this long after its buildings blew up. */
export const BLAST_SINK_DELAY = 0.7;

const GRAVITY = 18;

export interface Shard {
  /** Start, as a fraction of the building's footprint (x, z) and height (y). */
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  spin: number;
  size: number;
}

export interface Puff {
  angle: number;
  drift: number;
  rise: number;
  size: number;
  delay: number;
}

/** Same seed, same debris: two renders of one frame match. */
export function blastShards(seed: string, count: number): Shard[] {
  const rand = mulberry32(fnv1a(`${seed}#shards`));
  return Array.from({ length: count }, () => {
    const angle = rand() * Math.PI * 2;
    const speed = 2.5 + rand() * 5.5;
    return {
      x: (rand() - 0.5) * 0.9,
      y: 0.15 + rand() * 0.85,
      z: (rand() - 0.5) * 0.9,
      vx: Math.cos(angle) * speed,
      vy: 4 + rand() * 9,
      vz: Math.sin(angle) * speed,
      spin: (rand() - 0.5) * 14,
      size: 0.08 + rand() * 0.2,
    };
  });
}

export function blastPuffs(seed: string, count: number): Puff[] {
  const rand = mulberry32(fnv1a(`${seed}#puffs`));
  return Array.from({ length: count }, () => ({
    angle: rand() * Math.PI * 2,
    drift: 0.3 + rand() * 0.9,
    rise: 1.2 + rand() * 1.6,
    size: 0.6 + rand() * 0.6,
    delay: rand() * 0.35,
  }));
}

/** Building scale during the blast: [footprint, height], 0 once shattered. */
export function buildingBlastScale(age: number): [number, number] {
  if (age >= BLAST_POP) {
    return [0, 0];
  }
  const k = age / BLAST_POP;
  return [1 + 0.18 * k, 1 + 0.08 * k];
}

/** Shard world offset (building-relative, scaled by `width`/`height`), roll and scale at `age`. */
export function shardAt(
  s: Shard,
  age: number,
  width: number,
  height: number,
  out: { x: number; y: number; z: number; roll: number; scale: number },
) {
  const t = Math.max(0, age - BLAST_POP * 0.5);
  const y0 = s.y * height;
  // Lands when y0 + vy t - g t²/2 = 0, then lies still.
  const land = (s.vy + Math.sqrt(s.vy * s.vy + 2 * GRAVITY * y0)) / GRAVITY;
  const fly = Math.min(t, land);
  const spread = Math.max(0.6, width * 0.6);
  out.x = s.x * width + s.vx * fly * spread * 0.35;
  out.z = s.z * width + s.vz * fly * spread * 0.35;
  out.y = t >= land ? 0 : Math.max(0, y0 + s.vy * fly - 0.5 * GRAVITY * fly * fly);
  out.roll = s.spin * fly;
  const fade = Math.min(1, Math.max(0, (BLAST_SEC - age) / (BLAST_SEC * 0.3)));
  out.scale = age < BLAST_POP * 0.5 ? 0 : s.size * Math.max(0.8, width * 0.45) * fade;
}

/** Fireball radius (× building size) and heat in [0, 1]: a flash that cools into smoke. */
export function fireballAt(age: number): { radius: number; heat: number } {
  if (age < BLAST_POP * 0.5 || age > 1.1) {
    return { radius: 0, heat: 0 };
  }
  const t = age - BLAST_POP * 0.5;
  const grow = 1 - Math.exp(-t * 14);
  const heat = Math.max(0, 1 - t / 0.9);
  return { radius: (0.55 + 0.45 * grow) * (0.4 + 0.6 * heat ** 0.5), heat };
}

/** Smoke puff position (× building size) and radius: rises and spreads, then thins out. */
export function puffAt(
  p: Puff,
  age: number,
  out: { x: number; y: number; z: number; scale: number },
) {
  const t = age - 0.2 - p.delay;
  if (t <= 0) {
    out.scale = 0;
    return;
  }
  const life = BLAST_SEC - 0.2 - p.delay;
  const k = Math.min(1, t / life);
  out.x = Math.cos(p.angle) * p.drift * (0.4 + k);
  out.z = Math.sin(p.angle) * p.drift * (0.4 + k);
  out.y = 0.5 + p.rise * (1 - (1 - k) ** 2);
  out.scale = p.size * (0.5 + k * 0.9) * Math.sin(Math.PI * Math.min(1, k * 1.1)) ** 0.6;
}
