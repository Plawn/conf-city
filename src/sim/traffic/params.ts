/** Tuning of the traffic simulation (see `sim.ts`). */

/** World units per second, before the ±15 % spread. */
export const CAR_SPEED = 2.4;
export const TRUCK_SPEED = 1.8;
/** Spawn spread along the path so a burst does not leave in lockstep. */
export const SPAWN_JITTER = 0.6;
/** Centre-to-centre distance a follower keeps (a vehicle is 0.55 long). */
export const MIN_GAP = 0.9;
/**
 * Probes along the vehicle's own path, `PROBE_STEP` apart; slot 0 is the vehicle
 * itself. 3.2 units of reach: a circulating vehicle must be seen by one about to
 * enter the ring while the latter can still stop short of the lane.
 */
export const PROBE_STEP = 0.4;
export const PROBES = 8;
export const SLOTS = PROBES + 1;
/**
 * A body this close to one of my probes is on my path. Covers a tube of 0.3
 * around the path with no gap between probes (√(0.3² + 0.2²)); still under the
 * lane spacing of a boulevard (0.42), so the neighbouring lane is not followed.
 */
export const HIT_RADIUS = 0.36;
/**
 * Two probes this close are the same spot. Wider than `HIT_RADIUS`: a vehicle
 * held one probe short of such a spot then keeps its body more than
 * `HIT_RADIUS` off the other's path, so the vehicle it lets through never
 * stops for it in turn. Also the reach of the hash lookup (`CELL`, 3×3 cells).
 */
export const YIELD_RADIUS = 0.6;
export const CELL = YIELD_RADIUS;
export const HASH_SIZE = 4096;
/**
 * A vehicle with the way, due at the spot less than this long after I would
 * have cleared it (a full `MIN_GAP` past it, accelerating from where I am),
 * still gets it.
 */
export const YIELD_MARGIN = 0.4;
/** Speed a vehicle is assumed to reach when working out how long it needs to clear a spot. */
export const ENTRY_SPEED = 1.0;
/**
 * A yielding vehicle keeps its body this far from the path of the vehicle it
 * lets through — measured straight from the body to that vehicle's probes, not
 * along its own path, which may curl into the other's lane (a roundabout entry
 * joins the ring 0.15 after leaving the approach). A full following gap, so the
 * vehicle let through never brakes for it.
 */
export const CLEAR = MIN_GAP;
/** Seconds within which two merging arrivals count as simultaneous (priority to the right decides). */
export const TIE = 0.2;
/** Tolerance of `canStop` on a vehicle already parked at CLEAR. */
export const STOP_SLACK = 0.05;
/**
 * A vehicle rolling with the spot this close ahead is already in it, and
 * everyone else treats it as a body on their path.
 */
export const COMMITTED = PROBE_STEP;
export const ACCEL = 2.5;
export const BRAKE = 6;
/** Speed gained per unit of gap beyond `MIN_GAP` when following. */
export const GAIN = 2;
/**
 * Gain of the following law. Stiffer than the holds: on an S-bend the chord
 * between two vehicles shrinks even at equal speed, and the steady-state error
 * of the controller is what the bumpers get — `(v_lead - v) / FOLLOW_GAIN`.
 */
export const FOLLOW_GAIN = 3;
/** The curvature cap is read this far ahead, so braking starts before the bend. */
export const BRAKE_LOOKAHEAD = 0.5;
/** Heading dot products: above → same way (follow); below → oncoming (ignore); between → crossing. */
export const SAME_WAY = 0.5;
export const ONCOMING = -0.3;
/** A vehicle less than this far ahead along my path is beside or behind me. */
export const BEHIND = 0.1;
/** Speed a stopped vehicle is assumed to have when working out who reaches a spot first. */
export const CREEP = 0.5;
/** Spawn clearance, centre to centre, from any vehicle already on the route. */
export const SPAWN_GAP = MIN_GAP * 1.2;
/** Speed below which a held vehicle counts as stalled; above which its stall clock resets. */
export const STALLED = 0.05;
export const MOVING = 0.3;
/**
 * A vehicle held this long gets a priority token for `TOKEN` seconds: the others
 * yield to it if they can still stop. The token outlives its first move — a
 * clock that reset as soon as it moved would hand the turn straight back and
 * the two would creep into the junction together.
 */
export const PATIENCE = 1.5;
export const TOKEN = 2.0;
/** Spawn attempts on a loop before giving up for this frame. */
export const LOOP_SPAWN_TRIES = 3;
