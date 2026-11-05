import { describe, expect, test } from "bun:test";
import {
  parseScenario,
  type Scenario,
  type ScenarioCity,
  type ScenarioNode,
} from "../../src/domain/scenario";
import {
  alignMoves,
  capEvents,
  condenseScenario,
  countBeats,
  dropEmptyLinks,
  findMoves,
  fitPacing,
  foldStaging,
  groupMoves,
  labelKey,
  markClouds,
  mergeChurn,
  planChapters,
  pruneShort,
  snapBursts,
  stackOf,
} from "../../src/domain/scenarioCondense";

const node = (id: string, extra: Partial<ScenarioNode> = {}): ScenarioNode => ({
  id,
  type: "app",
  label: id,
  ...extra,
});

const city = (
  id: string,
  nodes: ScenarioNode[],
  extra: Partial<ScenarioCity> = {},
): ScenarioCity => ({
  id,
  name: id.charAt(0).toUpperCase() + id.slice(1),
  nodes,
  ...extra,
});

const scenario = (cities: ScenarioCity[], extra: Partial<Scenario> = {}): Scenario => ({
  title: "t",
  start: "2026-01-01",
  end: "2026-12-31",
  durationSec: 60,
  cities,
  ...extra,
});

const find = (scn: Scenario, address: string) => {
  const [c, n] = address.split("/");
  return scn.cities.find((x) => x.id === c)?.nodes.find((x) => x.id === n);
};

describe("helpers", () => {
  test("stack is the id prefix, else the group, else the id", () => {
    expect(stackOf({ id: "survey.api" })).toBe("survey");
    expect(stackOf({ id: "api", group: "billing" })).toBe("billing");
    expect(stackOf({ id: "api" })).toBe("api");
  });
  test("label key ignores case and parentheticals", () => {
    expect(labelKey({ id: "x", label: "Grafana (compose)" })).toBe("grafana");
  });
});

describe("rule 1: churn", () => {
  test("a service gone and back within churnDays is one lifetime", () => {
    const scn = scenario([
      city("a", [
        node("legacy.app", { label: "App", until: "2026-03-01" }),
        node("app", { label: "App", since: "2026-03-20" }),
      ]),
    ]);
    const { scenario: out, merged } = mergeChurn(scn);
    expect(merged).toEqual([{ address: "a/app", absorbed: ["a/legacy.app"] }]);
    expect(find(out, "a/legacy.app")).toBeUndefined();
    expect(find(out, "a/app")?.since).toBeUndefined();
  });
  test("past churnDays they stay apart", () => {
    const scn = scenario([
      city("a", [
        node("old", { label: "App", until: "2026-03-01" }),
        node("app", { label: "App", since: "2026-06-01" }),
      ]),
    ]);
    expect(mergeChurn(scn).merged).toEqual([]);
  });
  test("an id reappearing on another island is a move, not churn", () => {
    const scn = scenario([
      city("a", [
        node("old", { label: "App", until: "2026-03-01" }),
        node("app", { label: "App", since: "2026-03-05" }),
      ]),
      city("b", [node("old", { label: "App", since: "2026-03-02" })]),
    ]);
    expect(mergeChurn(scn).merged.map((m) => m.address)).toEqual([]);
  });
  test("a staging twin folds into production", () => {
    const scn = scenario([
      city("a", [
        node("survey-staging", { label: "Survey staging", since: "2026-02-01" }),
        node("survey", { label: "Survey", since: "2026-02-20" }),
      ]),
    ]);
    const { scenario: out, merged } = foldStaging(scn);
    expect(merged).toEqual([{ address: "a/survey", absorbed: ["a/survey-staging"] }]);
    expect(find(out, "a/survey")?.since).toBe("2026-02-01");
  });
});

describe("rule 2: prune", () => {
  test("short lives go, their links too, then empty islands; migration ends stay", () => {
    const scn = scenario([
      city("a", [
        node("keep", { links: ["blip"] }),
        node("blip", { since: "2026-02-01", until: "2026-02-05" }),
      ]),
      city("b", [node("only", { since: "2026-04-01", until: "2026-04-03" })], {
        since: "2026-04-01",
      }),
      city("c", [node("end", { since: "2026-05-01", until: "2026-05-04" })]),
    ]);
    const {
      scenario: out,
      pruned,
      droppedCities,
    } = pruneShort(scn, { minDays: 14 }, new Set(["c/end"]));
    expect(pruned).toEqual(["a/blip", "b/only"]);
    expect(droppedCities).toEqual(["b"]);
    expect(find(out, "a/keep")?.links).toEqual([]);
    expect(find(out, "c/end")).toBeDefined();
  });
});

describe("rule 3: migrations", () => {
  const scn = scenario([
    city("sand", [
      node("grafana", { until: "2026-03-20" }),
      node("legacy.vm", { label: "VictoriaMetrics", until: "2026-03-18" }),
    ]),
    city("tools", [
      node("grafana", { since: "2026-03-15" }),
      node("vmetrics", { label: "VictoriaMetrics (v2)", since: "2026-03-15" }),
    ]),
  ]);
  test("matched by id, then by label, within moveDays", () => {
    const moves = findMoves(scn);
    expect(moves.map((m) => `${m.fromCity}/${m.fromId}>${m.toCity}/${m.toId}`).sort()).toEqual([
      "sand/grafana>tools/grafana",
      "sand/legacy.vm>tools/vmetrics",
    ]);
    expect(findMoves(scn, { moveDays: 1 }).map((m) => m.toId)).toEqual([]);
  });
  test("the old one leaves the day the new one rises, grouped by date", () => {
    const moves = alignMoves(scn, findMoves(scn));
    expect(find(scn, "sand/grafana")?.until).toBe("2026-03-15");
    expect(groupMoves(moves)).toEqual([
      { fromCity: "sand", toCity: "tools", at: "2026-03-15", nodes: ["grafana", "vmetrics"] },
    ]);
  });
});

describe("rule 4: snap", () => {
  test("bursts and stacks share a date, removals too", () => {
    const scn = scenario([
      city("a", [
        node("x", { since: "2026-03-01" }),
        node("y", { since: "2026-03-03" }),
        node("svc.api", { since: "2026-05-01" }),
        node("svc.front", { since: "2026-05-09" }),
        node("old1", { until: "2026-07-01" }),
        node("old2", { until: "2026-07-03" }),
      ]),
    ]);
    const { scenario: out } = snapBursts(scn);
    expect(find(out, "a/y")?.since).toBe("2026-03-01");
    expect(find(out, "a/svc.front")?.since).toBe("2026-05-01");
    expect(find(out, "a/old2")?.until).toBe("2026-07-01");
  });
  test("an island keeps its date; arrivals in its window join it", () => {
    const scn = scenario([
      city("a", [node("x", { since: "2026-03-01" })]),
      city("b", [node("y", { since: "2026-03-03" })], { since: "2026-03-03" }),
    ]);
    const { scenario: out } = snapBursts(scn);
    expect(out.cities[1]?.since).toBe("2026-03-03");
    expect(find(out, "a/x")?.since).toBe("2026-03-01");
  });
  test("arrivals in the first openDays belong to the starting point", () => {
    const { scenario: out } = snapBursts(
      scenario([city("a", [node("x", { since: "2026-01-05" })])]),
    );
    expect(find(out, "a/x")?.since).toBeUndefined();
  });
  test("links that can never show are dropped", () => {
    const scn = scenario([
      city("a", [
        node("x", { until: "2026-03-01", links: ["y"] }),
        node("y", { since: "2026-03-01" }),
      ]),
    ]);
    expect(dropEmptyLinks(scn)).toBe(1);
    expect(find(scn, "a/x")?.links).toEqual([]);
  });
});

describe("clouds", () => {
  const scn = scenario([
    city("azure", [node("llm", { building: "relay-station" })], {
      meta: { cpuCores: 2, memMb: 8192 },
    }),
    city("worker", [node("runner", { building: "relay-pylon" })]),
  ]);
  test("every service with an external look makes a cloud, without memMb", () => {
    const { scenario: out, clouds } = markClouds(scn);
    expect(clouds).toEqual(["azure"]);
    expect(out.cities[0]?.cloud).toBe(true);
    expect(out.cities[0]?.meta).toEqual({ cpuCores: 2 });
    expect(out.cities[1]?.cloud).toBeUndefined();
  });
  test("an explicit list wins", () => {
    expect(markClouds(scn, ["worker"]).clouds).toEqual(["worker"]);
  });
});

describe("rule 7: event cap", () => {
  const stack = (prefix: string, n: number, life: Partial<ScenarioNode>) =>
    Array.from({ length: n }, (_, i) => node(`${prefix}.s${i}`, life));
  const scn = scenario([
    city("a", [
      node("db", { type: "db", since: "2026-02-01" }),
      ...stack("big", 4, { since: "2026-03-01" }),
      ...stack("small", 2, { since: "2026-04-01" }),
      ...stack("legacy", 3, { until: "2026-05-01" }),
    ]),
  ]);
  test("legacy teardowns go first, then the smallest stacks; db stays", () => {
    const { scenario: out, cut } = capEvents(scn, {
      topStacks: Infinity,
      maxEvents: 6,
      teaser: false,
    });
    expect(cut).toEqual(
      [...stack("legacy", 3, {}), ...stack("small", 2, {})].map((n) => `a/${n.id}`).sort(),
    );
    expect(find(out, "a/db")).toBeDefined();
    expect(countBeats(out)).toBeLessThanOrEqual(6);
  });
  test("the teaser keeps only the top stacks", () => {
    const { cut } = capEvents(scn, { topStacks: 1, maxEvents: 100, teaser: true });
    expect(cut.some((a) => a.startsWith("a/big."))).toBe(false);
    expect(cut.filter((a) => a.startsWith("a/small.")).length).toBe(2);
  });
});

describe("cable cars", () => {
  test("each cloud keeps the island end of its longest-lived link", () => {
    const scn = scenario(
      [
        city("tools", [
          node("base", { type: "db" }),
          node("short.a", { since: "2026-05-01" }),
          node("long.a", { since: "2026-02-01" }),
          node("filler.a", { since: "2026-03-01" }),
          node("filler.b", { since: "2026-03-01" }),
        ]),
        city("groq", [node("llm")], { since: "2026-06-01", cloud: true }),
      ],
      {
        links: [
          { from: "tools/short.a", to: "groq/llm" },
          { from: "tools/long.a", to: "groq/llm" },
        ],
      },
    );
    const { scenario: out } = capEvents(scn, { topStacks: 0, maxEvents: 0, teaser: true });
    expect(out.links).toEqual([{ from: "tools/long.a", to: "groq/llm" }]);
  });
});

describe("rule 5: chapters", () => {
  const scn = scenario([
    city("tools", [
      node("base"),
      node("x.a", { since: "2026-02-10" }),
      node("x.b", { since: "2026-02-10" }),
      node("y.a", { since: "2026-05-01" }),
      node("y.b", { since: "2026-05-01" }),
    ]),
    city("quartz", [node("app", { since: "2026-05-05" })], { since: "2026-05-05" }),
    city("azure", [node("llm", { since: "2026-03-10" })], { since: "2026-03-10", cloud: true }),
  ]);
  test("opening, then island > cloud > burst, chapterDays apart, the stronger absorbing", () => {
    const chapters = planChapters(scn, [], {
      chapters: 9,
      maxChapters: 12,
      chapterDays: 10,
      lang: "en",
    });
    expect(chapters.map((c) => [c.at, c.title])).toEqual([
      ["2026-01-01", "The starting point"],
      ["2026-02-10", "X"],
      ["2026-03-10", "Azure in the cloud"],
      ["2026-05-05", "Quartz joins"],
    ]);
    expect(chapters[0]?.caption).toBe("1 service on 1 island");
    expect(chapters[3]?.stat).toBe("+3 services");
  });
  test("the count is capped and titles fit 32 characters, in French", () => {
    const chapters = planChapters(scn, [], {
      chapters: 2,
      maxChapters: 12,
      chapterDays: 10,
      lang: "fr",
    });
    expect(chapters.map((c) => c.title)).toEqual(["Le point de départ", "Quartz arrive"]);
    expect(chapters.every((c) => c.title.length <= 32)).toBe(true);
  });
});

describe("rule 6: pacing", () => {
  test("durationSec is solved so the video lands on target", () => {
    const scn = scenario([
      city("a", [
        node("x", { since: "2026-03-01" }),
        node("y", { since: "2026-06-01" }),
        node("z"),
      ]),
    ]);
    const { scenario: out, totalSec } = fitPacing(scn, {
      targetSec: 40,
      minGapSec: 0.8,
      staggerSec: 0.25,
      maxGapSec: 30,
      chapterSec: 1.8,
      introSec: 3,
      outroSec: 6,
    });
    expect(Math.abs(totalSec - 40)).toBeLessThan(2);
    expect(parseScenario(out).totalSec).toBe(totalSec);
  });
  test("a saturated time-lapse raises maxGapSec instead", () => {
    const scn = scenario([city("a", [node("x", { since: "2026-03-01" }), node("z")])]);
    const { scenario: out, totalSec } = fitPacing(scn, {
      targetSec: 60,
      minGapSec: 0.8,
      staggerSec: 0.25,
      maxGapSec: 1,
      chapterSec: 1.8,
      introSec: 3,
      outroSec: 6,
    });
    expect(out.maxGapSec).toBeGreaterThan(1);
    expect(Math.abs(totalSec - 60)).toBeLessThan(2);
  });
});

describe("condenseScenario", () => {
  const scn = scenario([
    city("tools", [
      node("base"),
      node("other"),
      node("grafana", { since: "2026-04-01", until: "2026-08-01" }),
    ]),
    city("groq", [node("llm", { building: "relay-station" })], {
      since: "2026-06-04",
      meta: { memMb: 8192 },
    }),
    city("worker", [node("runner")], { since: "2026-06-09" }),
    city("quartz", [node("grafana", { since: "2026-08-01" }), node("app")], {
      since: "2026-08-01",
    }),
  ]);
  test("clouds marked, lang set, every chapter long enough for a camera move", () => {
    const { scenario: out, report } = condenseScenario(scn, { lang: "fr", targetSec: 40 });
    expect(out.lang).toBe("fr");
    expect(report.clouds).toEqual(["groq"]);
    expect(out.cities.find((c) => c.id === "groq")?.meta?.memMb).toBeUndefined();
    expect(Math.abs(report.totalSec - 40)).toBeLessThan(2);
    expect(report.chapterSec.every((s) => s >= 6)).toBe(true);
    expect(parseScenario(out).chapters.length).toBe(report.chapters.length);
    expect(report.chapters.every((c) => c.title.length <= 32)).toBe(true);
  });
  test("deterministic", () => {
    expect(condenseScenario(scn)).toEqual(condenseScenario(scn));
  });
  test("unknown node fields survive", () => {
    const { scenario: out } = condenseScenario(scn);
    expect(find(out, "groq/llm")?.building).toBe("relay-station");
  });
});

