// Machine-level stats, read from the host's procfs.
//
// Container stats only account for what the orchestrator schedules: everything else
// running on the box — the kernel, dockerd, systemd, and any container outside Swarm —
// is invisible to them. Summing container usage therefore under-reports the machine,
// badly for CPU (host processes usually dominate) and mildly for memory.
//
// The agent runs in a container, so it needs the host's /proc bind-mounted (like
// node-exporter does). Without that mount every read fails and the reader stays
// silent — callers fall back to the container sum.

import { statfsSync } from "node:fs";

import type { CityMetrics } from "../protocol.ts";

/** Where the host's procfs is mounted inside the container. */
const HOST_PROC = process.env.HOST_PROC || "/host/proc";
/**
 * A path on the host's root filesystem, for the disk *space* gauge. Unlike /proc, this
 * one really needs its own bind-mount: the container's own `/` is the overlay, whose
 * statfs reports whatever backs /var/lib/docker — close to the truth on a simple box,
 * wrong as soon as the host splits its partitions. Outside a container `/` is correct.
 */
const HOST_FS = process.env.HOST_FS || "/hostfs";

/** Sector size used by /proc/diskstats counters — fixed at 512 bytes, always. */
const SECTOR_BYTES = 512;
const MB = 1024 * 1024;

/** Cumulative bytes read/written across the machine's disks. */
interface DiskIoSample {
  at: number;
  readBytes: number;
  writeBytes: number;
}

/**
 * Whole disks only, so a device is not counted twice through its partitions. A name is
 * a partition when another listed device is its prefix and the rest is just an index
 * (`sda` + `1`, `nvme0n1` + `p1`). Virtual and removable devices are dropped outright:
 * `dm-*` would double the volume underneath it.
 */
const VIRTUAL_DEVICE = /^(loop|ram|zram|sr|fd|dm-|md)/;

function isWholeDisk(name: string, all: Set<string>): boolean {
  if (VIRTUAL_DEVICE.test(name)) {
    return false;
  }
  for (const other of all) {
    if (other !== name && name.startsWith(other) && /^p?\d+$/.test(name.slice(other.length))) {
      return false;
    }
  }
  return true;
}

/** Sum the sector counters of /proc/diskstats: field 6 read, field 10 written. */
function parseDiskstats(text: string, at: number): DiskIoSample | null {
  const rows: { name: string; read: number; written: number }[] = [];
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/);
    // major minor name reads merged sectorsRead msRead writes merged sectorsWritten …
    if (f.length < 10) {
      continue;
    }
    const name = f[2]!;
    const read = Number(f[5]);
    const written = Number(f[9]);
    if (Number.isNaN(read) || Number.isNaN(written)) {
      continue;
    }
    names.add(name);
    rows.push({ name, read, written });
  }
  if (rows.length === 0) {
    return null;
  }

  let readBytes = 0;
  let writeBytes = 0;
  for (const r of rows) {
    if (!isWholeDisk(r.name, names)) {
      continue;
    }
    readBytes += r.read * SECTOR_BYTES;
    writeBytes += r.written * SECTOR_BYTES;
  }
  return { at, readBytes, writeBytes };
}

interface CpuSample {
  /** Jiffies across every state, all cores. */
  total: number;
  /** Jiffies spent idle (idle + iowait). */
  idle: number;
}

/** Aggregate `cpu` line of /proc/stat, plus the number of `cpuN` lines. */
function parseStat(text: string): { sample: CpuSample; cores: number } | null {
  let sample: CpuSample | null = null;
  let cores = 0;
  for (const line of text.split("\n")) {
    if (!line.startsWith("cpu")) {
      break; // the cpu lines always come first
    }
    const parts = line.split(/\s+/);
    const name = parts[0]!;
    if (name === "cpu") {
      // user nice system idle iowait irq softirq steal — guest is already counted in user.
      const v = parts.slice(1, 9).map(Number);
      if (v.length < 5 || v.some(Number.isNaN)) {
        return null;
      }
      sample = {
        total: v.reduce((a, b) => a + b, 0),
        idle: (v[3] ?? 0) + (v[4] ?? 0),
      };
    } else {
      cores++;
    }
  }
  return sample ? { sample, cores } : null;
}

/** MemTotal - MemAvailable, in MB — what `free` calls "used". */
function parseMeminfo(text: string): number | undefined {
  const kb = new Map<string, number>();
  for (const line of text.split("\n")) {
    const m = line.match(/^(\w+):\s+(\d+)\s+kB/);
    if (m) {
      kb.set(m[1]!, Number(m[2]));
    }
  }
  const total = kb.get("MemTotal");
  if (total == null) {
    return undefined;
  }
  // MemAvailable exists since Linux 3.14; the fallback is the pre-3.14 approximation.
  const available =
    kb.get("MemAvailable") ??
    (kb.get("MemFree") ?? 0) + (kb.get("Buffers") ?? 0) + (kb.get("Cached") ?? 0);
  return Math.round(Math.max(0, total - available) / 1024);
}

export class HostStatsReader {
  private prev: CpuSample | null = null;
  private cores = 0;
  /** Previous disk counters — throughput is a rate, so it needs two reads. */
  private prevIo: DiskIoSample | null = null;
  /** Logged once, so a missing mount doesn't spam the agent's output. */
  private warned = false;
  private warnedFs = false;

  /** Used/total of the host root filesystem, `df` semantics. Null when unreachable. */
  private diskSpace(): { usedMb: number; totalMb: number } | null {
    try {
      const fs = statfsSync(HOST_FS);
      const total = fs.blocks * fs.bsize;
      if (!(total > 0)) {
        return null;
      }
      return {
        usedMb: Math.round(((fs.blocks - fs.bfree) * fs.bsize) / MB),
        totalMb: Math.round(total / MB),
      };
    } catch {
      if (!this.warnedFs) {
        console.warn(
          `[host] ${HOST_FS} unreadable — disk space disabled. ` +
            `Mount the host root (-v /:${HOST_FS}:ro) to enable it.`,
        );
        this.warnedFs = true;
      }
      return null;
    }
  }

  /** True once a /proc/stat read has succeeded. */
  available = false;

  /**
   * One machine-level sample. `cpuUsedCores` needs two reads (it is a rate), so it is
   * absent on the first call. Returns null when the host's procfs is not reachable.
   */
  async read(at: number): Promise<CityMetrics | null> {
    let stat: string;
    try {
      stat = await Bun.file(`${HOST_PROC}/stat`).text();
    } catch {
      if (!this.warned) {
        console.warn(
          `[host] ${HOST_PROC}/stat unreadable — machine-level CPU/memory disabled. ` +
            `Mount the host procfs (-v /proc:${HOST_PROC}:ro) to enable it.`,
        );
        this.warned = true;
      }
      return null;
    }
    this.available = true;

    const parsed = parseStat(stat);
    const out: CityMetrics = { at };

    if (parsed) {
      if (parsed.cores > 0) {
        this.cores = parsed.cores;
      }
      const prev = this.prev;
      this.prev = parsed.sample;
      if (prev) {
        const dTotal = parsed.sample.total - prev.total;
        const dIdle = parsed.sample.idle - prev.idle;
        // Counters only go up; a decrease means the host was rebooted under us.
        if (dTotal > 0 && dIdle >= 0) {
          const busyRatio = Math.max(0, Math.min(1, (dTotal - dIdle) / dTotal));
          out.cpuUsedCores = Math.round(busyRatio * this.cores * 100) / 100;
        }
      }
    }

    const [meminfo, loadavg, diskstats] = await Promise.all([
      Bun.file(`${HOST_PROC}/meminfo`)
        .text()
        .catch(() => null),
      Bun.file(`${HOST_PROC}/loadavg`)
        .text()
        .catch(() => null),
      Bun.file(`${HOST_PROC}/diskstats`)
        .text()
        .catch(() => null),
    ]);
    if (meminfo) {
      out.memUsedMb = parseMeminfo(meminfo);
    }
    if (loadavg) {
      const l1 = Number(loadavg.trim().split(/\s+/)[0]);
      if (!Number.isNaN(l1)) {
        out.load1 = l1;
      }
    }

    const space = this.diskSpace();
    if (space) {
      out.diskUsedMb = space.usedMb;
      out.diskTotalMb = space.totalMb;
    }

    if (diskstats) {
      const cur = parseDiskstats(diskstats, at);
      const prevIo = this.prevIo;
      if (cur) {
        this.prevIo = cur;
      }
      if (cur && prevIo) {
        const dt = (cur.at - prevIo.at) / 1000;
        // Counters only go up; a decrease means the host rebooted or a disk went away.
        if (dt > 0 && cur.readBytes >= prevIo.readBytes && cur.writeBytes >= prevIo.writeBytes) {
          out.diskReadMbPerSec =
            Math.round(((cur.readBytes - prevIo.readBytes) / MB / dt) * 100) / 100;
          out.diskWriteMbPerSec =
            Math.round(((cur.writeBytes - prevIo.writeBytes) / MB / dt) * 100) / 100;
        }
      }
    }

    return out;
  }
}
