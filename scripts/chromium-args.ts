/** Chromium flags for the headless checks: SwiftShader for CI, the Vulkan adapter otherwise. */
export function chromiumArgs(backend: string, software: boolean): string[] {
  const vulkan = ["--use-angle=vulkan", "--enable-features=Vulkan", "--disable-vulkan-surface"];
  if (!software) {
    // Without these Linux headless Chromium silently falls back to SwiftShader on both backends.
    return ["--no-sandbox", "--enable-unsafe-webgpu", ...vulkan];
  }
  return [
    "--no-sandbox",
    "--enable-unsafe-webgpu",
    "--enable-unsafe-swiftshader",
    ...(backend === "webgl"
      ? ["--use-angle=swiftshader"]
      : ["--use-vulkan=swiftshader", ...vulkan]),
  ];
}
