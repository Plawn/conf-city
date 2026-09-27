// Dummy telemetry: per-node metrics, the machines under them, and liveness — all random walks.

import type { CityMeta, CityMetrics, LivenessStatus, MetricSnapshot } from "../../protocol.ts";
import { round } from "../units.ts";
import { transitionLiveness, walk } from "./random.ts";

export interface NodeInfo {
  address: string; // "cityId/nodeId"
  type: string;
  label: string;
  group?: string;
  description?: string;
  links?: string[];
  hidden?: boolean;
  cpuLimit: number; // cores
  memLimitMb: number;
}

interface MetricState {
  cpu: number;
  memoryMb: number;
  rps: number;
  latencyMs: number;
  errorRate: number;
  netRx: number;
  netTx: number;
}

function initMetrics(type: string): MetricState {
  switch (type) {
    case "app":
      return {
        cpu: 30,
        memoryMb: 512,
        rps: 200,
        latencyMs: 15,
        errorRate: 0.005,
        netRx: 800,
        netTx: 2500,
      };
    case "db":
      return {
        cpu: 40,
        memoryMb: 2048,
        rps: 500,
        latencyMs: 3,
        errorRate: 0.001,
        netRx: 1200,
        netTx: 4000,
      };
    case "cache":
      return {
        cpu: 10,
        memoryMb: 256,
        rps: 1000,
        latencyMs: 0.5,
        errorRate: 0.0005,
        netRx: 3000,
        netTx: 6000,
      };
    case "queue":
      return {
        cpu: 15,
        memoryMb: 384,
        rps: 100,
        latencyMs: 5,
        errorRate: 0.002,
        netRx: 400,
        netTx: 400,
      };
    default:
      return {
        cpu: 20,
        memoryMb: 256,
        rps: 50,
        latencyMs: 10,
        errorRate: 0.01,
        netRx: 100,
        netTx: 100,
      };
  }
}

/** Per-node metric collector; `last()` is the latest batch it returned. */
export function createNodeMetrics(allNodes: NodeInfo[]) {
  const metricState = new Map<string, MetricState>();
  for (const node of allNodes) {
    metricState.set(node.address, initMetrics(node.type));
  }
  let lastNodeMetrics: Record<string, MetricSnapshot> = {};

  const collect = (): Record<string, MetricSnapshot> => {
    const out: Record<string, MetricSnapshot> = {};
    for (const node of allNodes) {
      const s = metricState.get(node.address)!;
      s.cpu = walk(s.cpu, 5, 2, 95);
      s.memoryMb = walk(s.memoryMb, 50, 64, node.memLimitMb * 0.95);
      s.rps = walk(s.rps, 20, 0, 5000);
      s.latencyMs = walk(s.latencyMs, 3, 0.1, 500);
      s.errorRate = walk(s.errorRate, 0.005, 0, 0.15);
      s.netRx = walk(s.netRx, 300, 0, 20000);
      s.netTx = walk(s.netTx, 500, 0, 40000);
      // cpu is expressed like Docker: % of one core, can exceed 100 on multi-core limits
      const cpuPct = (s.cpu / 100) * node.cpuLimit * 100;
      out[node.address] = {
        cpu: round(cpuPct, 1),
        memoryMb: Math.round(Math.min(s.memoryMb, node.memLimitMb)),
        rps: Math.round(s.rps),
        latencyMs: round(s.latencyMs, 1),
        errorRate: round(s.errorRate, 4),
        cpuLimit: node.cpuLimit,
        memLimitMb: node.memLimitMb,
        netRxKbps: Math.round(s.netRx),
        netTxKbps: Math.round(s.netTx),
      };
    }
    lastNodeMetrics = out;
    return out;
  };

  return { collect, last: () => lastNodeMetrics };
}

// ── Host-level metrics ──
// A machine is more than the services it runs: kernel, daemons, and containers outside
// the orchestrator. The dummy reproduces that gap so the city badge exercises the same
// path as a real node agent reading /proc.

/** Machine collector: the latest node metrics summed per city, plus host overhead and disk. */
export function createCityMetrics(
  cityMeta: Record<string, CityMeta>,
  lastNodeMetrics: () => Record<string, MetricSnapshot>,
): () => Record<string, CityMetrics> {
  const hostOverhead = new Map(
    Object.keys(cityMeta).map((id) => [id, { cpuCores: 0.6, memMb: 1800 }]),
  );

  /** Disk is a property of the box, so the dummy gives each city its own drive. */
  const hostDisk = new Map<
    string,
    { totalMb: number; usedMb: number; read: number; write: number }
  >([
    ["paris-1", { totalMb: 512_000, usedMb: 190_000, read: 4, write: 12 }],
    ["london-1", { totalMb: 256_000, usedMb: 205_000, read: 2, write: 6 }],
  ]);

  return () => {
    const at = Date.now();
    const out: Record<string, CityMetrics> = {};
    for (const [cityId, meta] of Object.entries(cityMeta)) {
      let cpuCores = 0;
      let memMb = 0;
      for (const [address, m] of Object.entries(lastNodeMetrics())) {
        if (!address.startsWith(`${cityId}/`)) {
          continue;
        }
        cpuCores += (m.cpu ?? 0) / 100;
        memMb += m.memoryMb ?? 0;
      }
      const overhead = hostOverhead.get(cityId)!;
      overhead.cpuCores = walk(overhead.cpuCores, 0.15, 0.1, 2.5);
      overhead.memMb = walk(overhead.memMb, 150, 600, 5000);
      const usedCores = Math.min(meta.cpuCores ?? Infinity, cpuCores + overhead.cpuCores);
      const disk = hostDisk.get(cityId);
      if (disk) {
        // Space creeps, throughput jumps around — the two behave nothing alike.
        disk.usedMb = walk(disk.usedMb, 60, disk.totalMb * 0.05, disk.totalMb * 0.97);
        disk.read = walk(disk.read, 8, 0, 300);
        disk.write = walk(disk.write, 10, 0, 400);
      }
      out[cityId] = {
        cpuUsedCores: round(usedCores, 2),
        memUsedMb: Math.round(Math.min(meta.memMb ?? Infinity, memMb + overhead.memMb)),
        load1: round(usedCores * 1.2, 2),
        ...(disk && {
          diskUsedMb: Math.round(disk.usedMb),
          diskTotalMb: disk.totalMb,
          diskReadMbPerSec: round(disk.read, 2),
          diskWriteMbPerSec: round(disk.write, 2),
        }),
        at,
      };
    }
    return out;
  };
}

// ── Liveness ──

/** Liveness collector: every node starts healthy, then follows the Markov chain. */
export function createLiveness(allNodes: NodeInfo[]): () => Record<string, LivenessStatus> {
  const livenessState = new Map<string, LivenessStatus>();
  for (const node of allNodes) {
    livenessState.set(node.address, "healthy");
  }

  return () => {
    const out: Record<string, LivenessStatus> = {};
    for (const node of allNodes) {
      const current = livenessState.get(node.address)!;
      const next = transitionLiveness(current);
      livenessState.set(node.address, next);
      out[node.address] = next;
    }
    return out;
  };
}
