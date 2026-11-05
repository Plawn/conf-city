// Frame-by-frame export of a replay scenario: headless pages in `?capture=1`, screenshots piped to ffmpeg.
// Usage: bun scripts/render-replay.ts public/scenarios/example.json [out.mp4|out.webm]
//   [--fps 30] [--seconds N] [--from S] [--width 1920 --height 1080] [--workers 3] [--frames dir]
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { availableParallelism, homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseScenario } from "../src/domain/scenario";
import { launchCheck } from "./harness";

const argv = process.argv.slice(2);
const flags = new Map<string, string>();
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!;
  if (arg.startsWith("--")) {
    flags.set(arg.slice(2), argv[++i] ?? "");
  } else {
    positional.push(arg);
  }
}
const scenario = positional[0];
if (!scenario) {
  console.error(
    "usage: bun scripts/render-replay.ts <scenario.json> [out.mp4|out.webm] [--fps 30]",
  );
  process.exit(1);
}
const output = positional[1] ?? "out/replay/replay.mp4";
const fps = Number(flags.get("fps") ?? 30);
const from = Number(flags.get("from") ?? 0);
const width = Number(flags.get("width") ?? 1920);
const height = Number(flags.get("height") ?? 1080);
const framesDir = flags.get("frames");
// Each worker is a Chromium of its own on a contiguous slice; frames with --frames stay on one.
const workers = framesDir ? 1 : Math.max(1, Number(flags.get("workers") ?? 3));
// A file under public/ is served from the site root.
const scenarioUrl = scenario.startsWith("http")
  ? scenario
  : `/${scenario.replace(/^(\.?\/)?(public\/)?/, "")}`;

const webm = output.endsWith(".webm");
const ffmpeg = findFfmpeg(webm);
// Playwright's bundled ffmpeg only decodes JPEG and encodes VP8: enough for a WebM preview.
const encoder = webm
  ? ["-c:v", "libvpx", "-b:v", "8M", "-crf", "6", "-deadline", "good"]
  : ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "medium"];
// JPEG: a quarter of a PNG screenshot's cost, invisible once encoded.
const QUALITY = 95;

const base = process.env.CITY_URL ?? "http://127.0.0.1:4174/";
// Headless screenshots of a WebGPU canvas come back blank: export through WebGL unless asked.
process.env.CITY_BACKEND ??= "webgl";
const renderer = process.env.CITY_BACKEND === "webgl" ? "&renderer=webgl" : "";
const url = `${base}?replay=${encodeURIComponent(scenarioUrl)}&capture=1&cinema=1&quality=high${renderer}`;

if (!ffmpeg && !framesDir) {
  throw new Error("ffmpeg not found (set FFMPEG or install it), or pass --frames <dir>");
}
const total = await scenarioLength();
const seconds = Math.min(Number(flags.get("seconds") ?? total), total - from);
const count = Math.round(seconds * fps);
await mkdir(join(output, ".."), { recursive: true });
if (framesDir) {
  await mkdir(framesDir, { recursive: true });
}
console.log(
  `${count} frames @ ${fps} fps (${from}s → ${from + seconds}s), ${width}×${height}, ${workers} worker(s)`,
);
const started = performance.now();
let done = 0;
const per = Math.ceil(count / workers);
const slices = Array.from({ length: workers }, (_, w) => ({
  first: w * per,
  frames: Math.max(0, Math.min(per, count - w * per)),
  out: workers === 1 ? output : `${output}.part${w}${webm ? ".webm" : ".mp4"}`,
})).filter((s) => s.frames > 0);
const errors = (await Promise.all(slices.map(renderSlice))).flat();
if (slices.length > 1 && ffmpeg) {
  await concat(
    ffmpeg,
    slices.map((s) => s.out),
  );
}
console.log(`→ ${output} in ${((performance.now() - started) / 60000).toFixed(1)} min`);
if (errors.length > 0) {
  console.warn(`${errors.length} page error(s) during capture`);
}

/** Render frames `first … first+frames` into `out` in a browser of its own; the page errors. */
async function renderSlice(slice: { first: number; frames: number; out: string }) {
  const { browser, page, errors } = await launchCheck("replay", { width, height });
  // Software rendering can take minutes per frame.
  page.setDefaultTimeout(900_000);
  const encode = ffmpeg
    ? Bun.spawn(ffmpegCommand(ffmpeg, slice.out), {
        stdin: "pipe",
        stdout: "inherit",
        stderr: "inherit",
      })
    : null;
  try {
    await page.goto(url);
    await page.waitForFunction(() => window.__CITY_REPLAY__ != null);
    for (let i = 0; i < slice.frames; i++) {
      const n = slice.first + i;
      const t = from + n / fps;
      await page.evaluate(([time, rate]) => window.__CITY_REPLAY__!.frame(time!, rate!), [t, fps]);
      const shot = await page.screenshot({ type: "jpeg", quality: QUALITY });
      // Waits when ffmpeg falls behind instead of buffering every frame.
      await encode?.stdin.write(shot);
      if (framesDir) {
        await Bun.write(join(framesDir, `${String(n).padStart(5, "0")}.jpg`), shot);
      }
      if (++done % (fps * 5) === 0) {
        const rate = done / ((performance.now() - started) / 1000);
        const left = (count - done) / rate / 60;
        console.log(
          `  ${done}/${count} — ${rate.toFixed(1)} frames/s, ~${left.toFixed(0)} min left`,
        );
      }
    }
    if (encode) {
      encode.stdin.end();
      if ((await encode.exited) !== 0) {
        throw new Error("ffmpeg failed");
      }
    }
  } finally {
    await browser.close();
  }
  return errors;
}

/** The scenario's length, parsed here: a throwaway browser first leaves the next one's screenshots hanging. */
async function scenarioLength(): Promise<number> {
  const response = await fetch(new URL(scenarioUrl, base));
  if (!response.ok) {
    throw new Error(`${scenarioUrl}: HTTP ${response.status}`);
  }
  return parseScenario(await response.json()).totalSec;
}

/** Join the slices without re-encoding, then drop them. */
async function concat(bin: string, parts: string[]) {
  const list = `${output}.parts.txt`;
  await writeFile(list, parts.map((p) => `file '${resolve(p)}'`).join("\n"));
  const proc = Bun.spawn(
    [
      bin,
      "-y",
      "-loglevel",
      "error",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      list,
      "-c",
      "copy",
      output,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  if ((await proc.exited) !== 0) {
    throw new Error("ffmpeg concat failed");
  }
  await Promise.all([list, ...parts].map((p) => rm(p)));
}

function ffmpegCommand(bin: string, out: string): string[] {
  const args = [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "image2pipe",
    "-c:v",
    "mjpeg",
    "-framerate",
    String(fps),
  ];
  // Several encoders share the CPU with the browsers.
  const threads = ["-threads", String(Math.max(2, Math.floor(availableParallelism() / workers)))];
  if (!bin.includes("ms-playwright")) {
    return [bin, ...args, "-i", "-", ...encoder, ...threads, out];
  }
  // The bundled build has no pipe protocol, and Bun's stdin is a socket `/dev/stdin` cannot open.
  const quoted = [bin, ...args, "-i", "file:/dev/stdin", ...encoder, out].map((a) => `'${a}'`);
  return ["sh", "-c", `cat | ${quoted.join(" ")}`];
}

function findFfmpeg(webm: boolean): string | null {
  if (process.env.FFMPEG) {
    return process.env.FFMPEG;
  }
  const system = Bun.which("ffmpeg");
  if (system) {
    return system;
  }
  const bundled = join(homedir(), ".cache/ms-playwright/ffmpeg-1011/ffmpeg-linux");
  return webm && existsSync(bundled) ? bundled : null;
}
