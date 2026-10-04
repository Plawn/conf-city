// Compare blur paths on the very same simulation frame, not two animated screenshots.
process.env.CITY_RENDER_MODE ??= "office";
process.env.CITY_WIDTH ??= "1280";
process.env.CITY_HEIGHT ??= "800";
const {
  assertHardwareAdapter,
  benchmarkEnvironment,
  benchmarkPage,
  benchmarkParams,
  cityUrl,
  launchCheck,
  savePng,
  withLightingPanel,
} = await import("./harness");
const { lightingCases, loadBenchmarkWorld, previewLighting } = await import("./lighting-fixture");

const { browser, page, output, errors, backend, software } = await launchCheck(
  "bloom-visual",
  benchmarkPage,
);
const baseParams = benchmarkParams();
const params = `${baseParams}${/tweaks=/.test(baseParams) ? "" : "&tweaks="}`;
const results: object[] = [];
const metadata = { ...benchmarkEnvironment(browser, params), buildAssets: [] as string[] };
try {
  await page.goto(`${cityUrl}?perf=1&idle=0&bloomCompare=1&renderer=${backend}${params}`);
  await page.waitForFunction(() => window.__CITY_RENDER__);
  metadata.buildAssets = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLScriptElement>('script[type="module"]')].map(
      (script) => script.src,
    ),
  );
  await loadBenchmarkWorld(page);
  metadata.adapter = await assertHardwareAdapter(page, software);
  for (const [name, date] of lightingCases) {
    if (process.env.CITY_CASE && process.env.CITY_CASE !== name) {
      continue;
    }
    await withLightingPanel(page, () => previewLighting(page, date));
    await page.keyboard.press("f");
    await page.waitForTimeout(3000);
    for (const view of ["fit-all", "beacon"]) {
      if (view === "beacon") {
        await page.evaluate(() => {
          const api = window.__CITY_RENDER__!;
          const state = api.inspect();
          const source =
            state.sources.find((source) => source.id === state.shadowBeaconId) ??
            state.sources.find((source) => source.kind === "beacon");
          if (!source) {
            throw new Error("No beacon available for the bloom closeup");
          }
          const [x, y, z] = source.position as [number, number, number];
          api.focus([x + 12, y + 10, z + 16], [x, y, z]);
        });
        await page.waitForTimeout(2000);
      }
      const images = await page.evaluate(() => window.__CITY_RENDER__!.captureBloomComparison());
      const comparisons = await page.evaluate(async (images) => {
        const decode = async (url: string) => {
          const bitmap = await createImageBitmap(await (await fetch(url)).blob());
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          const context = canvas.getContext("2d")!;
          context.drawImage(bitmap, 0, 0);
          bitmap.close();
          return { canvas, pixels: context.getImageData(0, 0, canvas.width, canvas.height).data };
        };
        const [reference, referenceControl, optimized, optimizedControl] = await Promise.all([
          decode(images.reference),
          decode(images.referenceControl),
          decode(images.optimized),
          decode(images.optimizedControl),
        ]);
        const compare = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
          let sum = 0;
          let max = 0;
          let changed = 0;
          let aboveOne = 0;
          const difference = new Uint8ClampedArray(a.length);
          for (let i = 0; i < a.length; i += 4) {
            let pixelMax = 0;
            for (let channel = 0; channel < 3; channel++) {
              const delta = Math.abs(a[i + channel]! - b[i + channel]!);
              sum += delta;
              pixelMax = Math.max(pixelMax, delta);
              difference[i + channel] = Math.min(255, delta * 16);
            }
            difference[i + 3] = 255;
            max = Math.max(max, pixelMax);
            changed += Number(pixelMax > 0);
            aboveOne += Number(pixelMax > 1);
          }
          return {
            meanAbsoluteRgb: sum / ((a.length / 4) * 3),
            maxChannel: max,
            changedPixelFraction: changed / (a.length / 4),
            pixelsAboveOneFraction: aboveOne / (a.length / 4),
            difference,
          };
        };
        const { difference, ...comparison } = compare(reference.pixels, optimized.pixels);
        const { difference: _referenceDiff, ...referenceNoise } = compare(
          reference.pixels,
          referenceControl.pixels,
        );
        const { difference: _optimizedDiff, ...optimizedNoise } = compare(
          optimized.pixels,
          optimizedControl.pixels,
        );
        const width = reference.canvas.width;
        const height = reference.canvas.height;
        const diffCanvas = document.createElement("canvas");
        diffCanvas.width = width;
        diffCanvas.height = height;
        diffCanvas.getContext("2d")!.putImageData(new ImageData(difference, width, height), 0, 0);
        return {
          width,
          height,
          comparison,
          referenceNoise,
          optimizedNoise,
          amplifiedDifference: diffCanvas.toDataURL("image/png"),
        };
      }, images);
      const { amplifiedDifference, ...metrics } = comparisons;
      const label = `${name}-${view}`;
      for (const [kind, image] of Object.entries(images)) {
        await savePng(image, `${output}/${label}-${kind}.png`);
      }
      await savePng(amplifiedDifference, `${output}/${label}-difference-x16.png`);
      results.push({
        label,
        ...metrics,
        scene: await page.evaluate(() => window.__CITY_RENDER__!.inspect()),
      });
      await Bun.write(
        `${output}/report.json`,
        JSON.stringify({ metadata, results, errors }, null, 2),
      );
      if (metrics.referenceNoise.maxChannel || metrics.optimizedNoise.maxChannel) {
        throw new Error(`${label}: repeated captures differ; the visual comparison is invalid`);
      }
      // Report precision losses instead of hiding them behind a global average.
      // This classification is a numerical indicator, not a perceptual guarantee.
      const classification =
        metrics.comparison.maxChannel <= 2 && metrics.comparison.meanAbsoluteRgb <= 0.05
          ? "within-rounding-tolerance"
          : "precision-tradeoff";
      Object.assign(results.at(-1)!, { classification });
      await Bun.write(
        `${output}/report.json`,
        JSON.stringify({ metadata, results, errors }, null, 2),
      );
      console.log(`${label}: ${classification}, ${JSON.stringify(metrics.comparison)}`);
    }
  }
  if (errors.length) {
    throw new Error(`Browser errors: ${errors.join("\n")}`);
  }
  await Bun.write(
    `${output}/review.html`,
    `<!doctype html>
<html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Bloom : rendu avant / après</title>
<style>
body{margin:24px;background:#111827;color:#f3f4f6;font:16px system-ui;max-width:1400px}
select,input{font:inherit;margin:8px 0}a{color:#93c5fd}
.images{position:relative;width:100%;aspect-ratio:1.6;background:#000}
.images img{position:absolute;width:100%;height:100%;object-fit:contain}
#optimized{clip-path:inset(0 50% 0 0)}#slider{width:100%}
.labels{display:flex;justify-content:space-between}#metrics{white-space:pre-wrap;font:14px monospace}
</style>
<h1>Bloom : rendu avant / après</h1>
<p>Les deux images utilisent le même état de simulation. Référence : RGBA16F.
Optimisé : format effectif indiqué ci-dessous. Les buffers compacts réduisent la précision : ce changement n'est pas sans pertes.</p>
<label>Vue <select id="view"></select></label>
<div class="images"><img id="reference" alt="Bloom de référence"><img id="optimized" alt="Bloom optimisé"></div>
<input id="slider" type="range" min="0" max="100" value="50" aria-label="Proportion du rendu optimisé">
<div class="labels"><span>Optimisé à gauche</span><span>Référence à droite</span></div>
<p id="metrics"></p><p><a id="difference">Écarts amplifiés ×16</a> · <a href="report.json">Mesures brutes</a></p>
<script type="application/json" id="data">${JSON.stringify(results).replaceAll("<", "\\u003c")}</script>
<script>
const data=JSON.parse(document.getElementById('data').textContent);
const view=document.getElementById('view'), reference=document.getElementById('reference'), optimized=document.getElementById('optimized');
for(const row of data){const option=document.createElement('option');option.value=row.label;option.textContent=row.label;view.append(option)}
function update(){const row=data.find(row=>row.label===view.value);reference.src=row.label+'-reference.png';optimized.src=row.label+'-optimized.png';document.getElementById('difference').href=row.label+'-difference-x16.png';document.querySelector('.images').style.aspectRatio=row.width+'/'+row.height;
document.getElementById('metrics').textContent=[
'Format effectif : '+row.scene.bloom.storage+' / échelle '+row.scene.bloom.resolutionScale,
'Pixels différents : '+(row.comparison.changedPixelFraction*100).toFixed(4)+' %',
'Pixels avec un écart > 1/255 : '+(row.comparison.pixelsAboveOneFraction*100).toFixed(4)+' %',
'Écart moyen RGB : '+row.comparison.meanAbsoluteRgb.toFixed(6)+' / 255',
'Écart maximal sur un canal : '+row.comparison.maxChannel+' / 255',
'Classement numérique : '+row.classification,
'Contrôles répétés : '+row.referenceNoise.maxChannel+' / '+row.optimizedNoise.maxChannel+' (doivent être 0)'
].join(String.fromCharCode(10))}
view.onchange=update;document.getElementById('slider').oninput=event=>{optimized.style.clipPath='inset(0 '+(100-event.target.value)+'% 0 0)'};update();
</script></html>`,
  );
  console.log(`Visual report: ${output}/report.json`);
} finally {
  await browser.close();
}
