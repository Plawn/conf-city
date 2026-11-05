import { describe, expect, test } from "bun:test";
import {
  CARD_FADE_IN,
  CARD_FADE_OUT,
  chapterAt,
  chapterStat,
  progressAt,
  recapAt,
  recapFigures,
  scenarioStats,
  timeLapseAt,
} from "@/domain/replayStats";
import { parseScenario, type Scenario } from "@/domain/scenario";
import example from "../../public/scenarios/example.json";

const base = example as unknown as Scenario;
const chapters = [
  { at: "2026-03-01", title: "Le cache" },
  { at: "2026-07-01", title: "Grand ménage", caption: "MySQL part", stat: "−1 base" },
  { at: "2026-08-01", title: "Londres" },
];
const withChapters = (extra: Partial<Scenario> = {}) =>
  parseScenario(structuredClone({ ...base, chapters, ...extra }));

/** example.json plus a worker moving from Paris to London in September. */
function movedScenario(lang?: string) {
  const scn = structuredClone({ ...base, chapters, ...(lang ? { lang } : {}) }) as Scenario;
  const paris = scn.cities.find((c) => c.id === "paris-1")!;
  paris.nodes.find((n) => n.id === "worker")!.until = "2026-09-05";
  scn.cities
    .find((c) => c.id === "london-1")!
    .nodes.push({ id: "worker", type: "app", label: "Worker", since: "2026-09-03" });
  return parseScenario(scn);
}

describe("chapter cards", () => {
  const tl = withChapters();

  test("chapters cover their window, none before the first or in the outro", () => {
    const [first, second] = tl.chapters;
    expect(chapterAt(tl, first!.at - 0.01)).toBeNull();
    expect(chapterAt(tl, first!.at)?.chapter.index).toBe(0);
    expect(chapterAt(tl, second!.at - 0.01)?.chapter.index).toBe(0);
    expect(chapterAt(tl, second!.at)?.chapter.index).toBe(1);
    expect(chapterAt(tl, tl.outroAt)).toBeNull();
    expect(chapterAt(tl, tl.outroAt - 0.01)?.progress).toBeCloseTo(1, 2);
  });

  test("the card fades in, holds through the hold, and is gone 0.5 s after", () => {
    const ch = tl.chapters[0]!;
    expect(chapterAt(tl, ch.at)!.card).toBe(0);
    expect(chapterAt(tl, ch.at)!.lift).toBe(1);
    expect(chapterAt(tl, ch.at + CARD_FADE_IN / 2)!.card).toBeCloseTo(0.5, 5);
    const full = chapterAt(tl, ch.at + 0.8)!;
    expect(full.card).toBe(1);
    expect(full.lift).toBe(0);
    expect(chapterAt(tl, ch.at + ch.holdSec - 0.01)!.card).toBe(1);
    const out = chapterAt(tl, ch.at + ch.holdSec + CARD_FADE_OUT / 2)!;
    expect(out.card).toBeCloseTo(0.5, 5);
    expect(out.lift).toBeLessThan(0);
    expect(chapterAt(tl, ch.at + ch.holdSec + CARD_FADE_OUT)!.card).toBe(0);
  });
});

describe("chapter stats", () => {
  test("an explicit stat wins", () => {
    const tl = withChapters();
    expect(chapterStat(tl, tl.chapters[1]!)).toBe("−1 base");
  });

  test("computed in English by default", () => {
    const tl = withChapters();
    // March → June: Redis, RabbitMQ, Worker.
    expect(chapterStat(tl, tl.chapters[0]!)).toBe("+3 services");
    // August onward: London rises with four services.
    expect(chapterStat(tl, tl.chapters[2]!)).toBe("+1 server · +4 services");
  });

  test("a service removed in one city and added in another moves, in French", () => {
    const tl = movedScenario("fr-FR");
    expect(chapterStat(tl, tl.chapters[0]!)).toBe("+3 services");
    expect(chapterStat(tl, tl.chapters[2]!)).toBe("+1 serveur · +4 services · 1 déménagé");
    const en = movedScenario();
    expect(chapterStat(en, en.chapters[2]!)).toBe("+1 server · +4 services · 1 moved");
  });

  test("demolitions without a twin are demolished", () => {
    const tl = withChapters({ chapters: [{ at: "2026-06-01", title: "Été" }] });
    expect(chapterStat(tl, tl.chapters[0]!)).toBe("+1 server · +4 services · 1 demolished");
  });
});

describe("recap", () => {
  test("figures over the whole scenario", () => {
    const stats = new Map(scenarioStats(movedScenario()).map((s) => [s.key, s]));
    expect(stats.get("islands")?.value).toBe(2);
    expect(stats.get("clouds")?.value).toBe(0);
    expect(stats.get("services")?.value).toBe(12);
    expect(stats.get("bridges")?.value).toBe(2);
    expect(stats.get("demolitions")?.value).toBe(1);
    expect(stats.get("moved")?.value).toBe(1);
    expect(stats.get("months")?.value).toBe(12);
    expect(stats.get("longestLived")?.detail).toBe("Frontend");
    expect(stats.get("longestLived")?.value).toBe(364);
    expect(stats.get("busiestMonth")?.date?.getMonth()).toBe(7);
    expect(stats.get("biggestDay")?.value).toBeGreaterThanOrEqual(1);
  });

  test("labels follow lang", () => {
    const fr = new Map(scenarioStats(movedScenario("fr")).map((s) => [s.key, s]));
    expect(fr.get("islands")?.label).toBe("serveurs");
    expect(fr.get("moved")?.label).toBe("déménagé");
    expect(fr.get("busiestMonth")?.detail).toBe("août 2026");
    const en = new Map(scenarioStats(movedScenario("en")).map((s) => [s.key, s]));
    expect(en.get("islands")?.label).toBe("servers");
    expect(en.get("demolitions")?.label).toBe("demolition");
  });

  test("six figures, zero counts dropped, stories last", () => {
    const figures = recapFigures(scenarioStats(withChapters()));
    expect(figures).toHaveLength(6);
    expect(figures.map((f) => f.key)).toEqual([
      "services",
      "islands",
      "bridges",
      "demolitions",
      "longestLived",
      "busiestMonth",
    ]);
  });

  test("counts up deterministically, staggered, settled within the outro", () => {
    const tl = withChapters();
    const figures = recapFigures(scenarioStats(tl));
    expect(recapAt(tl, tl.outroAt - 0.01, figures)).toBeNull();
    const early = recapAt(tl, tl.outroAt + 0.6, figures)!;
    expect(early.opacity).toBe(1);
    const share = (i: number) => early.shown[i]! / figures[i]!.value;
    expect(share(0)).toBeGreaterThan(0);
    expect(share(0)).toBeGreaterThan(share(5));
    const done = recapAt(tl, tl.outroAt + 2.5, figures)!;
    expect(done.shown).toEqual(figures.map((f) => f.value));
    expect(recapAt(tl, tl.outroAt + 1, figures)).toEqual(recapAt(tl, tl.outroAt + 1, figures));
  });
});

describe("progress and time-lapse", () => {
  test("progress runs 0 → 1 with a marker per chapter", () => {
    const tl = withChapters();
    const p = progressAt(tl, tl.chapters[1]!.at + 0.1);
    expect(p.markers).toHaveLength(3);
    expect(p.markers[1]).toBeCloseTo(tl.chapters[1]!.at / tl.totalSec, 9);
    expect(p.current).toBe(1);
    expect(progressAt(tl, 0).k).toBe(0);
    expect(progressAt(tl, 0).current).toBe(-1);
    expect(progressAt(tl, tl.totalSec + 1).k).toBe(1);
  });

  test("a compression leaps, the mean pace and holds do not", () => {
    const leaping = withChapters({ maxGapSec: 1 });
    const intro = leaping.scenario.introSec!;
    // 1 Jan → 1 Mar (59 days ≈ 6.5 s at the base pace) squeezed into 1 s.
    expect(timeLapseAt(leaping, intro + 0.6)).toBe(true);
    const ch = leaping.chapters[0]!;
    expect(timeLapseAt(leaping, ch.at + 0.8)).toBe(false);
    // A near-zero base pace (events spaced by minGapSec alone) leaps between distant dates.
    const spaced = withChapters({ durationSec: 1, minGapSec: 0.8, maxGapSec: 1 });
    let leaps = 0;
    for (let t = 0; t < spaced.totalSec; t += 0.1) {
      leaps += timeLapseAt(spaced, t) ? 1 : 0;
    }
    expect(leaps).toBeGreaterThan(0);
    const plain = withChapters();
    for (let t = 0; t < plain.totalSec; t += 0.1) {
      expect(timeLapseAt(plain, t)).toBe(false);
    }
  });
});
