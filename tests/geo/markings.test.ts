import { expect, test } from "bun:test";
import { TERRAIN } from "@/domain/nodeStyle";
import {
  crossingIntervals,
  DASH_LENGTH,
  DASH_PERIOD,
  dashStarts,
  drivewayRun,
  EDGE_INSET,
  endMargin,
  isCrossing,
  MARGIN_JUNCTION,
  MARGIN_PLAIN,
  MOUTH_GAP,
  mouthGaps,
  pavementSpans,
  zebraOffsets,
} from "@/geo/markings";
import type { GraphNode } from "@/geo/roadGraph";
import { CLASS_STYLE } from "@/geo/roadStyle";
import type { Driveway, Vec2 } from "@/layout/types";

const node = (kind: GraphNode["kind"], arms: number): GraphNode =>
  ({ pos: [0, 0], kind, arms: Array.from({ length: arms }, () => ({})) }) as GraphNode;

test("only a junction of three arms or more is a crossing", () => {
  expect(isCrossing(node("junction", 3))).toBe(true);
  expect(isCrossing(node("junction", 2))).toBe(false);
  expect(isCrossing(node("roundabout", 4))).toBe(false);
  expect(endMargin(node("junction", 4))).toBe(MARGIN_JUNCTION);
  expect(endMargin(node("end", 1))).toBe(MARGIN_PLAIN);
});

test("dashes are centred between the margins and never overrun them", () => {
  const starts = dashStarts(10, 0.5, 0.5, DASH_LENGTH, DASH_PERIOD);
  expect(starts.length).toBe(Math.floor((9 + DASH_PERIOD - DASH_LENGTH) / DASH_PERIOD));
  const first = starts[0]!;
  const last = starts.at(-1)! + DASH_LENGTH;
  expect(first).toBeGreaterThanOrEqual(0.5);
  expect(last).toBeLessThanOrEqual(9.5 + 1e-9);
  expect(first - 0.5).toBeCloseTo(9.5 - last, 9);
  expect(dashStarts(1.2, 0.5, 0.5, DASH_LENGTH, DASH_PERIOD)).toEqual([]);
});

test("pavement spans skip the sorted mouth gaps and drop slivers", () => {
  expect(
    pavementSpans(
      [
        [6, 7],
        [2, 3],
      ],
      10,
    ),
  ).toEqual([
    [0, 2],
    [3, 6],
    [7, 10],
  ]);
  // Overlapping gaps merge; a gap past the end leaves nothing after it.
  expect(
    pavementSpans(
      [
        [2, 4],
        [3, 5],
        [9.98, 11],
      ],
      10,
    ),
  ).toEqual([
    [0, 2],
    [5, 9.98],
  ]);
  expect(pavementSpans([[-1, 0.03]], 1)).toEqual([[0.03, 1]]);
});

test("a driveway mouth opens the pavement on the side of its door", () => {
  const cut: Vec2[] = [
    [0, 0],
    [10, 0],
  ];
  const d = (x: number, doorZ: number, mouthZ = 0): Driveway => ({
    mouth: [x, mouthZ],
    door: [x, doorZ],
    klass: "street",
  });
  const [neg, pos] = mouthGaps(cut, [d(3, 2), d(6, -2), d(8, 2, 1)]);
  expect(neg!.length + pos!.length).toBe(2);
  const all = [...neg!, ...pos!].sort((a, b) => a[0] - b[0]);
  expect(all[0]).toEqual([3 - MOUTH_GAP, 3 + MOUTH_GAP]);
  expect(all[1]).toEqual([6 - MOUTH_GAP, 6 + MOUTH_GAP]);
  expect(neg!.length).toBe(1);
});

test("zebra bands span the asphalt inside the edge insets", () => {
  const h = 0.8;
  const offsets = zebraOffsets(h);
  expect(offsets[0]).toBeCloseTo(-h + EDGE_INSET, 9);
  expect(offsets.at(-1)!).toBeLessThanOrEqual(h - EDGE_INSET + 1e-6);
  for (let i = 1; i < offsets.length; i++) {
    expect(offsets[i]! - offsets[i - 1]!).toBeCloseTo(0.2, 9);
  }
});

test("a crossing's zebra comes before its stop line, mirrored at the far end", () => {
  const near = crossingIntervals(0, 1);
  expect(near.zebra[0]).toBeLessThan(near.zebra[1]);
  expect(near.stop[0]).toBeGreaterThan(near.zebra[1]);
  const far = crossingIntervals(10, -1);
  expect(far.zebra[0]).toBeCloseTo(10 - near.zebra[1], 9);
  expect(far.stop[1]).toBeCloseTo(10 - near.stop[0], 9);
});

test("a driveway starts at the street's edge and is skipped inside it", () => {
  const setback = CLASS_STYLE.street.width / 2;
  const run = drivewayRun({ mouth: [0, 0], door: [0, 3], klass: "street" });
  expect(run).toEqual([
    [0, setback],
    [0, 3],
  ]);
  expect(drivewayRun({ mouth: [0, 0], door: [0, setback], klass: "street" })).toBeNull();
  expect(TERRAIN.drivewayWidth).toBeGreaterThan(0);
});
