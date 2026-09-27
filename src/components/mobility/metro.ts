import {
  advanceDistance,
  createPose,
  type Pose,
  pathDistance,
  projectTrajectory,
  samplePose,
  type Trajectory,
} from "./trajectory";

export const METRO_HEIGHT = 2.2;
export const WAGON_LENGTH = 0.7;
export const WAGON_SPACING = 0.8;
export const STOP_SECONDS = 6;
export const TRAVEL_SECONDS = 24;
/** One station to the next, dwell included. */
export const CYCLE_SECONDS = STOP_SECONDS + TRAVEL_SECONDS;
export const STATIONS = 3;
export const TRAINS = 2;
/** Half a round trip: the second rame is always on the far side of the loop. */
export const TRAIN_OFFSET = (STATIONS * CYCLE_SECONDS) / TRAINS;
/** `elapsed` wraps here — a whole number of round trips, so the timetable repeats. */
export const WRAP_SECONDS = 900;

export interface MetroFleet {
  route: Trajectory;
  elapsed: number;
  distances: Float64Array;
  speeds: Float64Array;
  poses: Pose[];
  scratch: Pose;
}

/**
 * Where a rame is in its timetable. `stop` is the raw arrival id: it only
 * repeats after a `WRAP_SECONDS` wrap, which is what lets a consumer fire
 * "a train has just arrived" exactly once per dwell (compare with `!==`,
 * never `>`: the id goes backwards on the wrap).
 */
export interface TrainSchedule {
  stop: number;
  station: number;
  local: number;
  dwelling: boolean;
  untilDeparture: number;
  untilArrival: number;
}

function createSchedule(): TrainSchedule {
  return {
    stop: 0,
    station: 0,
    local: 0,
    dwelling: true,
    untilDeparture: STOP_SECONDS,
    untilArrival: CYCLE_SECONDS,
  };
}

/** The timetable, and the only place its arithmetic lives. */
export function metroSchedule(
  elapsed: number,
  train: number,
  out: TrainSchedule = createSchedule(),
): TrainSchedule {
  const time = elapsed + train * TRAIN_OFFSET;
  const stop = Math.floor((time + 1e-8) / CYCLE_SECONDS);
  const local = Math.max(0, time - stop * CYCLE_SECONDS);
  out.stop = stop;
  out.station = ((stop % STATIONS) + STATIONS) % STATIONS;
  out.local = local;
  out.dwelling = local <= STOP_SECONDS;
  out.untilDeparture = STOP_SECONDS - local;
  out.untilArrival = CYCLE_SECONDS - local;
  return out;
}

const probe = createSchedule();

/**
 * Id of the visit standing at `station`, or -1 when no rame is.
 *
 * The rame is part of the id: the two rames serve a station 45 s apart but
 * their raw `stop` counters collide (rame B's 4th stop and rame A's 4th stop
 * are both id 3), so keying on `stop` alone would silently merge two
 * consecutive visits into one.
 */
export function stationDwellStop(elapsed: number, station: number): number {
  for (let train = 0; train < TRAINS; train++) {
    metroSchedule(elapsed, train, probe);
    if (probe.dwelling && probe.station === station) {
      return probe.stop * TRAINS + train;
    }
  }
  return -1;
}

/** Seconds of dwell left at `station`, or -1 when no rame is standing there. */
export function stationDwellRemaining(elapsed: number, station: number): number {
  for (let train = 0; train < TRAINS; train++) {
    metroSchedule(elapsed, train, probe);
    if (probe.dwelling && probe.station === station) {
      return Math.max(0, probe.untilDeparture);
    }
  }
  return -1;
}

/** Arc length of a station on the loop. */
export function stationDistance(route: Trajectory, station: number): number {
  return (station * route.total) / STATIONS;
}

function scheduledDistance(route: Trajectory, phase: number): number {
  const stop = Math.floor(phase / CYCLE_SECONDS);
  return (
    ((stop + Math.max(0, ((phase % CYCLE_SECONDS) - STOP_SECONDS) / TRAVEL_SECONDS)) *
      route.total) /
    STATIONS
  );
}

export function createMetroFleet(route: Trajectory, elapsed = 0): MetroFleet {
  const fleet: MetroFleet = {
    route,
    elapsed,
    distances: Float64Array.from([0, TRAIN_OFFSET], (offset) =>
      scheduledDistance(route, (elapsed + offset) % (STATIONS * CYCLE_SECONDS)),
    ),
    speeds: new Float64Array(TRAINS).fill(route.total / (STATIONS * TRAVEL_SECONDS)),
    poses: Array.from({ length: TRAINS * 2 }, createPose),
    scratch: createPose(),
  };
  updateMetroPoses(fleet);
  return fleet;
}

/** Keep the two rames and their timetable when infrastructure rebuilds the track. */
export function reconfigureMetroFleet(fleet: MetroFleet, route: Trajectory): void {
  fleet.route = route;
  for (let train = 0; train < TRAINS; train++) {
    const s = metroSchedule(fleet.elapsed, train, probe);
    if (s.dwelling) {
      fleet.distances[train] = stationDistance(route, s.station);
      fleet.speeds[train] = route.total / (STATIONS * TRAVEL_SECONDS);
    } else {
      const pose = fleet.poses[train * 2]!;
      const distance = projectTrajectory(route, pose.x, pose.y, pose.z);
      const target = stationDistance(route, (s.station + 1) % STATIONS);
      fleet.distances[train] = distance;
      fleet.speeds[train] = pathDistance(route, target - distance) / Math.max(1e-8, s.untilArrival);
    }
  }
  updateMetroPoses(fleet);
}

function updateMetroPoses(fleet: MetroFleet): void {
  for (let train = 0; train < TRAINS; train++) {
    for (let wagon = 0; wagon < 2; wagon++) {
      samplePose(
        fleet.route,
        fleet.distances[train]! - wagon * WAGON_SPACING,
        WAGON_LENGTH,
        fleet.poses[train * 2 + wagon]!,
        fleet.scratch,
      );
    }
  }
}

/** Integral of moving time, with tolerance at exact station boundaries. */
function movingSeconds(time: number): number {
  const stop = Math.floor((time + 1e-8) / CYCLE_SECONDS);
  return stop * TRAVEL_SECONDS + Math.max(0, time - stop * CYCLE_SECONDS - STOP_SECONDS);
}

/** Integrate only the moving part of a step, even when it crosses a station. */
export function advanceMetro(fleet: MetroFleet, dt: number): void {
  if (!Number.isFinite(dt) || dt <= 0) {
    return;
  }
  const speed = fleet.route.total / (STATIONS * TRAVEL_SECONDS);
  for (let train = 0; train < TRAINS; train++) {
    const start = fleet.elapsed + train * TRAIN_OFFSET;
    const end = start + dt;
    const firstStop = Math.floor((start + 1e-8) / CYCLE_SECONDS) + 1;
    const arrival = firstStop * CYCLE_SECONDS;
    const moving = Math.max(0, movingSeconds(Math.min(end, arrival)) - movingSeconds(start));
    fleet.distances[train] = advanceDistance(
      fleet.route,
      fleet.distances[train]!,
      fleet.speeds[train]!,
      moving,
    );
    if (end >= arrival - 1e-8) {
      fleet.speeds[train] = speed;
      fleet.distances[train] = advanceDistance(
        fleet.route,
        stationDistance(fleet.route, firstStop % STATIONS),
        speed,
        Math.max(0, movingSeconds(end) - movingSeconds(arrival)),
      );
    }
    const stop = Math.floor((end + 1e-8) / CYCLE_SECONDS);
    if (end - stop * CYCLE_SECONDS <= STOP_SECONDS + 1e-8) {
      fleet.speeds[train] = speed;
      fleet.distances[train] = pathDistance(
        fleet.route,
        stationDistance(fleet.route, stop % STATIONS),
      );
    }
  }
  fleet.elapsed = (fleet.elapsed + dt) % WRAP_SECONDS;
  updateMetroPoses(fleet);
}
