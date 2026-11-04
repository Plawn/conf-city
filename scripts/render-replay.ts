// Frame-by-frame export of a replay scenario: headless page in `?capture=1`, screenshots piped to ffmpeg.
// Usage: bun scripts/render-replay.ts public/scenarios/example.json [out.mp4|out.webm]
//   [--fps 30] [--seconds N] [--from S] [--width 1920 --height 1080] [--frames dir]
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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
// A file under public/ is served from the site root.
const scenarioUrl = scenario.startsWith("http")
  ? scenario
  : `/${scenario.replace(/^(\.?\/)?(public\/)?/, "")}`;

const webm = output.endsWith(".webm");
const ffmpeg = findFfmpeg(webm);
// Playwright's bundled ffmpeg only decodes JPEG and encodes VP8: enough for a WebM preview.
const encoder = webm
  ? ["-c:v", "libvpx", "-b:v", "8M", "-crf", "6", "-deadline", "good"]
  : ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "slow"];
const image = webm ? "jpeg" : "png";

const base = process.env.CITY_URL ?? "http://127.0.0.1:4174/";
// Headless screenshots of a WebGPU canvas come back blank: export through WebGL unless asked.
process.env.CITY_BACKEND ??= "webgl";
const renderer = process.env.CITY_BACKEND === "webgl" ? "&renderer=webgl" : "";
const url = `${base}?replay=${encodeURIComponent(scenarioUrl)}&capture=1&cinema=1&quality=high${renderer}`;

const { browser, page, errors } = await launchCheck("replay", { width, height });
// Software rendering can take minutes per frame.
page.setDefaultTimeout(900_000);
try {
  await page.goto(url);
  await page.waitForFunction(() => window.__CITY_REPLAY__ != null);
  const total = await page.evaluate(() => window.__CITY_REPLAY__!.totalSec);
  const seconds = Math.min(Number(flags.get("seconds") ?? total), total - from);
  const count = Math.round(seconds * fps);
  if (framesDir) {
    await mkdir(framesDir, { recursive: true });
  }
  await mkdir(join(output, ".."), { recursive: true });
  const encode = ffmpeg
    ? Bun.spawn(ffmpegCommand(ffmpeg), { stdin: "pipe", stdout: "inherit", stderr: "inherit" })
    : null;
  if (!encode && !framesDir) {
    throw new Error("ffmpeg not found (set FFMPEG or install it), or pass --frames <dir>");
  }
  console.log(`${count} frames @ ${fps} fps (${from}s → ${from + seconds}s), ${width}×${height}`);
  const started = performance.now();
  for (let n = 0; n < count; n++) {
    const t = from + n / fps;
    await page.evaluate(([time, rate]) => window.__CITY_REPLAY__!.frame(time!, rate!), [t, fps]);
    const shot = await page.screenshot({ type: image, quality: webm ? 95 : undefined });
    encode?.stdin.write(shot);
    if (framesDir) {
      await Bun.write(join(framesDir, `${String(n).padStart(5, "0")}.${image}`), shot);
    }
    if (n % fps === 0) {
      const rate = (n + 1) / ((performance.now() - started) / 1000);
      console.log(`  ${t.toFixed(1)} s — ${rate.toFixed(1)} frames/s`);
    }
  }
  if (encode) {
    encode.stdin.end();
    if ((await encode.exited) !== 0) {
      throw new Error("ffmpeg failed");
    }
    console.log(`→ ${output}`);
  }
  if (errors.length > 0) {
    console.warn(`${errors.length} page error(s) during capture`);
  }
} finally {
  await browser.close();
}

function ffmpegCommand(bin: string): string[] {
  const input = webm ? "mjpeg" : "png";
  const args = [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "image2pipe",
    "-c:v",
    input,
    "-framerate",
    String(fps),
  ];
  if (!bin.includes("ms-playwright")) {
    return [bin, ...args, "-i", "-", ...encoder, output];
  }
  // The bundled build has no pipe protocol, and Bun's stdin is a socket `/dev/stdin` cannot open.
  const quoted = [bin, ...args, "-i", "file:/dev/stdin", ...encoder, output].map((a) => `'${a}'`);
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
