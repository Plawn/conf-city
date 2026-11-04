import { dateAt, type Timeline } from "../../domain/scenario";
import { useReplayStore } from "../../store/replayStore";

const MONTH = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

/** Title card during the intro, then the scenario date and what stands. */
export function ReplayOverlay({
  timeline,
  counts,
}: {
  timeline: Timeline;
  counts: { cities: number; clouds: number; nodes: number };
}) {
  // Whole-tenth resolution: the overlay re-renders 10× a second, not every frame.
  const t = useReplayStore((s) => Math.floor(s.t * 10) / 10);
  const scn = timeline.scenario;
  const intro = scn.introSec ?? 3;
  const titleOpacity = Math.max(0, Math.min(1, (intro - t) / 0.8));
  return (
    <div className="pointer-events-none absolute inset-0 z-20 text-white">
      {titleOpacity > 0 && (
        <div
          className="absolute inset-x-0 top-[28%] text-center drop-shadow-lg"
          style={{ opacity: titleOpacity }}
        >
          <h1 className="text-5xl font-semibold tracking-tight">{scn.title}</h1>
          {scn.subtitle && <p className="mt-3 text-xl text-surface-200">{scn.subtitle}</p>}
        </div>
      )}
      <div className="glass-morphic-subtle absolute left-6 top-6 rounded-2xl px-5 py-3">
        <div className="text-2xl font-semibold capitalize tabular-nums">
          {MONTH.format(dateAt(timeline, t))}
        </div>
        <div className="mt-1 flex gap-4 text-sm text-surface-200 tabular-nums">
          <span>
            <strong className="text-white">{counts.cities}</strong>{" "}
            {counts.cities === 1 ? "server" : "servers"}
          </span>
          {counts.clouds > 0 && (
            <span>
              <strong className="text-white">{counts.clouds}</strong> cloud
            </span>
          )}
          <span>
            <strong className="text-white">{counts.nodes}</strong>{" "}
            {counts.nodes === 1 ? "service" : "services"}
          </span>
        </div>
      </div>
    </div>
  );
}
