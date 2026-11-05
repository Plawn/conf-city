import { type Change, countAt, monthAt } from "../../domain/replayHud";
import type { Timeline } from "../../domain/scenario";
import { useReplayStore } from "../../store/replayStore";

const MONTH = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
/** Seconds a month label takes to slide out for the next. */
const MONTH_FADE = 0.45;

const ease = (x: number) => 1 - (1 - x) ** 3;

/** Seconds a counter takes to roll to its new value. */
const ROLL = 0.3;

/** An odometer: the old value slides out, the new one in (up when it grows, down when it shrinks). */
function Rolling({ change }: { change: Change<number> }) {
  const { current, previous } = change;
  const k = ease(change.k);
  const dir = previous !== null && previous > current ? -1 : 1;
  return (
    <strong className="relative inline-block overflow-hidden align-bottom text-white">
      <span className="block" style={{ transform: `translateY(${(1 - k) * dir * 100}%)` }}>
        {current}
      </span>
      {previous !== null && (
        <span
          className="absolute inset-x-0 top-0 block"
          style={{ transform: `translateY(${-k * dir * 100}%)` }}
          aria-hidden
        >
          {previous}
        </span>
      )}
    </strong>
  );
}

/** Title card during the intro, then the scenario date and what stands. */
export function ReplayOverlay({ timeline }: { timeline: Timeline }) {
  // 30 Hz: one render per exported frame, cheap enough live for a handful of spans.
  const t = useReplayStore((s) => Math.floor(s.t * 30) / 30);
  const scn = timeline.scenario;
  const intro = scn.introSec ?? 3;
  const titleOpacity = Math.max(0, Math.min(1, (intro - t) / 0.8));
  const cities = countAt(timeline, t, ROLL, "cities");
  const clouds = countAt(timeline, t, ROLL, "clouds");
  const nodes = countAt(timeline, t, ROLL, "nodes");
  const month = monthAt(timeline, t, MONTH_FADE);
  const k = ease(month.k);
  return (
    <div className="pointer-events-none absolute inset-0 z-20 text-white">
      {titleOpacity > 0 && (
        <div
          className="absolute inset-x-0 top-[28%] text-center drop-shadow-lg"
          style={{
            opacity: titleOpacity,
            transform: `translateY(${(1 - titleOpacity) * -12}px)`,
          }}
        >
          <h1 className="text-5xl font-semibold tracking-tight">{scn.title}</h1>
          {scn.subtitle && <p className="mt-3 text-xl text-surface-200">{scn.subtitle}</p>}
        </div>
      )}
      <div className="glass-morphic-subtle absolute left-6 top-6 rounded-2xl px-5 py-3">
        <div className="relative overflow-hidden text-2xl font-semibold capitalize tabular-nums">
          <div style={{ opacity: k, transform: `translateY(${(1 - k) * 60}%)` }}>
            {MONTH.format(month.current)}
          </div>
          {month.previous && (
            <div
              className="absolute inset-0"
              style={{ opacity: 1 - k, transform: `translateY(${-k * 60}%)` }}
              aria-hidden
            >
              {MONTH.format(month.previous)}
            </div>
          )}
        </div>
        <div className="mt-1 flex gap-4 text-sm text-surface-200 tabular-nums">
          <span>
            <Rolling change={cities} /> {cities.current === 1 ? "server" : "servers"}
          </span>
          {(clouds.current > 0 || clouds.previous) && (
            <span>
              <Rolling change={clouds} /> cloud
            </span>
          )}
          <span>
            <Rolling change={nodes} /> {nodes.current === 1 ? "service" : "services"}
          </span>
        </div>
      </div>
    </div>
  );
}
