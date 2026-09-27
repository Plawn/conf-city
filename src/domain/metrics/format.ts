import { clamp01 } from "../../lib/math";
import type { MetricSnapshot } from "../types";
import type { ViewMode } from "../viewMode";
import { netKbps } from "./saturation";

/** Raw value + unit for ranking / bars, per view mode (health → memory). */
export function rankValue(mode: ViewMode, m: MetricSnapshot | undefined): number | undefined {
  switch (mode) {
    case "cpu":
      return m?.cpu;
    case "network":
      return netKbps(m);
    default:
      return m?.memoryMb;
  }
}

export const RANK_LABEL: Record<ViewMode, string> = {
  health: "Memory",
  cpu: "CPU",
  memory: "Memory",
  network: "Network",
};

export function formatRank(mode: ViewMode, v: number): string {
  switch (mode) {
    case "cpu":
      return `${v.toFixed(0)}%`;
    case "network":
      return formatKbps(v);
    default:
      return formatMb(v);
  }
}

export function formatMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/** `0.0123` → `"1.23%"` with `digits = 2`. */
export function formatPercent(ratio: number, digits = 0): string {
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** `"1 core"`, `"1.50 cores"`: `digits` fixes the decimals, raw number otherwise; plural above 1. */
export function formatCores(n: number, digits?: number): string {
  return `${digits == null ? n : n.toFixed(digits)} core${n > 1 ? "s" : ""}`;
}

/** Disk throughput. Megabytes per second, the unit disks are read in. */
export function formatMbPerSec(mbs: number): string {
  if (mbs >= 1024) {
    return `${(mbs / 1024).toFixed(1)} GB/s`;
  }
  if (mbs >= 10) {
    return `${Math.round(mbs)} MB/s`;
  }
  return `${mbs.toFixed(1)} MB/s`;
}

export function formatKbps(kbps: number): string {
  if (kbps >= 1_000_000) {
    return `${(kbps / 1_000_000).toFixed(1)} Gb/s`;
  }
  if (kbps >= 1000) {
    return `${(kbps / 1000).toFixed(1)} Mb/s`;
  }
  return `${Math.round(kbps)} kb/s`;
}

/** Green → orange → red ramp; t clamped to 0..1. Returns a CSS hex colour. */
export function heatColor(t: number): string {
  const x = clamp01(t);
  // stops: 0 → #3ddc84 (green), 0.5 → #ffb020 (orange), 1 → #ff3b3b (red)
  const stops: [number, [number, number, number]][] = [
    [0, [0x3d, 0xdc, 0x84]],
    [0.5, [0xff, 0xb0, 0x20]],
    [1, [0xff, 0x3b, 0x3b]],
  ];
  let a = stops[0]!,
    b = stops[stops.length - 1]!;
  for (let i = 0; i < stops.length - 1; i++) {
    if (x >= stops[i]![0] && x <= stops[i + 1]![0]) {
      a = stops[i]!;
      b = stops[i + 1]!;
      break;
    }
  }
  const k = b[0] === a[0] ? 0 : (x - a[0]) / (b[0] - a[0]);
  const c = a[1].map((v, i) => Math.round(v + (b[1][i]! - v) * k));
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** Tone for a saturation value (used by badges / bars). */
export function saturationTone(sat: number | undefined): "ok" | "warn" | "danger" | "muted" {
  if (sat == null) {
    return "muted";
  }
  if (sat >= 0.9) {
    return "danger";
  }
  if (sat >= 0.7) {
    return "warn";
  }
  return "ok";
}
