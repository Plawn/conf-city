/** Compare one effect on the same simulation frame, including repeated controls. */
export async function checkPostprocess(effect: "bloom" | "ao" | "water") {
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
    `${effect}-visual`,
    benchmarkPage,
  );
  const baseParams = benchmarkParams();
  const params = `${baseParams}${/tweaks=/.test(baseParams) ? "" : "&tweaks="}`;
  const results: object[] = [];
  const title = { bloom: "Bloom", ao: "Occlusion ambiante", water: "Eau" }[effect];
  const metadata = { ...benchmarkEnvironment(browser, params), buildAssets: [] as string[] };
  try {
    await page.goto(`${cityUrl}?perf=1&idle=0&${effect}Compare=1&renderer=${backend}${params}`);
    await page.waitForFunction(() => window.__CITY_RENDER__);
    metadata.buildAssets = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLScriptElement>('script[type="module"]')].map(
        (script) => script.src,
      ),
    );
    await loadBenchmarkWorld(page);
    metadata.adapter = await assertHardwareAdapter(page, software);
    for (const [name, date] of effect === "water" ? [...lightingCases].reverse() : lightingCases) {
      if (process.env.CITY_CASE && process.env.CITY_CASE !== name) {
        continue;
      }
      await withLightingPanel(page, () => previewLighting(page, date));
      await page.keyboard.press("f");
      await page.waitForTimeout(3000);
      for (const view of effect === "water"
        ? ["fit-all", "beacon", "distant"]
        : ["fit-all", "beacon"]) {
        if (view === "beacon") {
          await page.evaluate(() => {
            const api = window.__CITY_RENDER__!;
            const state = api.inspect();
            const source =
              state.sources.find((source) => source.id === state.shadowBeaconId) ??
              state.sources.find((source) => source.kind === "beacon");
            if (!source) {
              throw new Error("No beacon available for the postprocessing closeup");
            }
            const [x, y, z] = source.position as [number, number, number];
            api.focus([x + 12, y + 10, z + 16], [x, y, z]);
          });
          await page.waitForTimeout(2000);
        }
        if (view === "distant") {
          await page.evaluate(() => {
            const api = window.__CITY_RENDER__!;
            const target = api.inspect().target as [number, number, number] | undefined;
            if (!target) {
              throw new Error("No camera target for the distant-water comparison");
            }
            // Every water fragment is beyond the 220-unit ripple fade. The shore
            // remains visible, exercising foam independently of normal ripples.
            api.focus([target[0] + 170, 240, target[2] + 170], target);
          });
          await page.waitForTimeout(2000);
        }
        if (effect === "water") {
          // Compile both materials before inspecting their same-frame controls.
          await page.evaluate(() => window.__CITY_RENDER__!.captureWaterComparison());
          await page.waitForTimeout(1000);
        }
        const images: {
          reference: string;
          referenceControl: string;
          optimized: string;
          optimizedControl: string;
          withoutWater?: string;
          withoutWaterControl?: string;
        } = await page.evaluate(
          (effect) =>
            effect === "bloom"
              ? window.__CITY_RENDER__!.captureBloomComparison()
              : effect === "ao"
                ? window.__CITY_RENDER__!.captureAoComparison()
                : window.__CITY_RENDER__!.captureWaterComparison(),
          effect,
        );
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
          let waterControl = null;
          if (images.withoutWater && images.withoutWaterControl) {
            const [absent, absentControl] = await Promise.all([
              decode(images.withoutWater),
              decode(images.withoutWaterControl),
            ]);
            const { difference: _presenceDiff, ...presence } = compare(
              optimized.pixels,
              absent.pixels,
            );
            const { difference: _absentDiff, ...repeat } = compare(
              absent.pixels,
              absentControl.pixels,
            );
            waterControl = { presence, repeat };
          }
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
            waterControl,
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
        if (
          metrics.waterControl &&
          (metrics.waterControl.presence.maxChannel === 0 ||
            metrics.waterControl.repeat.maxChannel !== 0)
        ) {
          throw new Error(`${label}: absent-water control failed; material comparison is invalid`);
        }
        // Report precision losses instead of hiding them behind a global average.
        // This classification is a numerical indicator, not a perceptual guarantee.
        const classification =
          metrics.comparison.maxChannel === 0
            ? "bit-identical"
            : metrics.comparison.maxChannel <= 2 && metrics.comparison.meanAbsoluteRgb <= 0.05
              ? "within-rounding-tolerance"
              : effect === "bloom"
                ? "precision-tradeoff"
                : "arithmetic-difference";
        Object.assign(results.at(-1)!, { classification });
        await Bun.write(
          `${output}/report.json`,
          JSON.stringify({ metadata, results, errors }, null, 2),
        );
        if (process.env.CITY_ASSERT_IDENTICAL === "1" && metrics.comparison.maxChannel !== 0) {
          throw new Error(`${label}: optimized ${effect} differs from its reference`);
        }
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
<title>${title} : rendu avant / après</title>
<style>
body{margin:24px;background:#111827;color:#f3f4f6;font:16px system-ui;max-width:1400px}
select,input{font:inherit;margin:8px 0}a{color:#93c5fd}
.images{position:relative;width:100%;aspect-ratio:1.6;background:#000}
.images img{position:absolute;width:100%;height:100%;object-fit:contain}
#optimized{clip-path:inset(0 50% 0 0)}#slider{width:100%}
.labels{display:flex;justify-content:space-between}#metrics{white-space:pre-wrap;font:14px monospace}
</style>
<h1>${title} : rendu avant / après</h1>
<p>Les deux images utilisent le même état de simulation. ${effect === "bloom" ? "Les buffers compacts du bloom réduisent la précision : ce changement n'est pas sans pertes." : effect === "ao" ? "L'AO conserve ses échantillons, sa résolution et sa précision. Seul le stockage du filtre change. Les écarts mesurés sont indiqués ci-dessous." : "L'eau conserve ses textures, ses vagues et son éclairage. Le shader évite l'éclairage des fragments où sa contribution est exactement nulle. Les écarts mesurés sont indiqués ci-dessous."}</p>
<label>Vue <select id="view"></select></label>
<div class="images"><img id="reference" alt="Rendu de référence"><img id="optimized" alt="Rendu optimisé"></div>
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
'${effect === "water" ? "Shader eau" : "Format effectif"} : '+row.scene.${effect}.${effect === "water" ? "mode" : "storage"},
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
}
