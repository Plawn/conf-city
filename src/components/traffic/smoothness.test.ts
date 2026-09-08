import { expect, test } from "bun:test";
import sample from "../../data/sample.json";
import type { World } from "../../domain/types";
import { layoutWorld } from "../../layout/layoutWorld";
import { loadWorld } from "../../loaders/loadWorld";
import { buildMetroTrack } from "../mobility/metroTrack";
import { createPose, samplePose } from "../mobility/trajectory";
import { buildRouteGeom, laneGeometry } from "./routeGeometry";
import { upgradeLayout, worldRoutes } from "./worldRoutes";

/**
 * The whole world, measured — this is the test the diagnosis was made with.
 *
 * A fixture can show that one roundabout is smooth; only a sweep over every
 * route of every city, base *and* upgraded (which turns every segment into a
 * boulevard, so the outer lane rides 0.70 out), catches the combinations that
 * produced the folds: a boulevard roundabout, a bridge deck meeting a
 * boulevard, a ring seam. Before the rework the worst inter-segment turn was
 * 177.9° with 4 reversals, and the worst yaw a vehicle had to swallow in one
 * 30 Hz step was 104°.
 */
const world = sample as World;
const { nodes, links } = loadWorld(world);
const base = layoutWorld(
  world.cities.map((c) => c.id),
  nodes,
  links,
);
const infra = {
  cities: Object.fromEntries([...base.cities.keys()].map((id) => [id, 1 as const])),
  bridges: Object.fromEntries(base.bridges.map((b) => [b.key, true])),
};
const layouts = [
  ["base", base, { cities: {}, bridges: {} }],
  ["upgraded", upgradeLayout(base, infra), infra],
] as const;

const degrees = (dot: number) => (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;

for (const [label, layout, active] of layouts) {
  test(`every driven lane of the ${label} world turns smoothly and never reverses`, () => {
    const routes = worldRoutes(layout, links, active);
    expect(routes.length).toBeGreaterThan(0);
    let worstTurn = 0;
    let worstTurnAt = "";
    let worstYaw = 0;
    let worstYawAt = "";
    let reversals = 0;
    const a = createPose();
    const b = createPose();
    const scratch = createPose();
    for (const route of routes) {
      const geom = buildRouteGeom(route.points, route.lanes, route.ring, route.loop);
      expect(geom).not.toBeNull();
      for (const lane of [0, 1]) {
        const g = laneGeometry(geom, lane)!;
        for (let s = 0; s + 1 < g.dirX.length; s++) {
          const dot =
            g.dirX[s]! * g.dirX[s + 1]! + g.dirY[s]! * g.dirY[s + 1]! + g.dirZ[s]! * g.dirZ[s + 1]!;
          if (dot < 0) {
            reversals++;
          }
          const turn = degrees(dot);
          if (turn > worstTurn) {
            worstTurn = turn;
            worstTurnAt = `${route.key}:lane${lane}:${s}`;
          }
        }
        // The yaw the renderer actually shows: a chord over the vehicle's own
        // length, advanced by one 30 Hz step at the speed the curvature cap allows.
        for (let s = 0; s < g.cap.length; s++) {
          const d = g.cum[s]!;
          samplePose(g, d, 0.55, a, scratch);
          samplePose(g, d + (1.5 * g.cap[s]!) / 30, 0.55, b, scratch);
          const yaw = degrees(a.fx * b.fx + a.fy * b.fy + a.fz * b.fz);
          if (yaw > worstYaw) {
            worstYaw = yaw;
            worstYawAt = `${route.key}:lane${lane}:${s}`;
          }
        }
      }
    }
    expect({ reversals, worstTurnAt, worstYawAt, worstTurn, worstYaw }).toMatchObject({
      reversals: 0,
    });
    // 8°, not 6°: the residual is the pitch kink where a bridge arch's ramp
    // meets flat land, which is `deckHeight`'s business, not the lane's.
    expect(worstTurn).toBeLessThan(8);
    expect(worstYaw).toBeLessThan(4);
  });
}

test("the metro rides its own viaduct: one turn round the island, no roundabouts", () => {
  for (const [label, layout] of layouts) {
    for (const [cityId, city] of layout.cities) {
      const track = buildMetroTrack(city.roads.ring);
      expect(track).not.toBeNull();
      const g = track!;
      let rotation = 0;
      let worst = 0;
      for (let s = 0; s + 1 < g.dirX.length; s++) {
        const cross = g.dirX[s]! * g.dirZ[s + 1]! - g.dirZ[s]! * g.dirX[s + 1]!;
        const dot = g.dirX[s]! * g.dirX[s + 1]! + g.dirZ[s]! * g.dirZ[s + 1]!;
        const turn = Math.atan2(cross, dot);
        rotation += turn;
        worst = Math.max(worst, Math.abs(turn));
      }
      const where = `${label}/${cityId}`;
      // A simple closed loop turns exactly once. The road loop, dragged round
      // every bridgehead roundabout, turned 610° and 998°.
      expect([where, Math.round((Math.abs(rotation) * 180) / Math.PI)]).toEqual([where, 360]);
      expect([where, (worst * 180) / Math.PI < 5]).toEqual([where, true]);
    }
  }
});
