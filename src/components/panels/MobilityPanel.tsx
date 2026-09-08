import { useState } from "react";
import { EMPTY_INFRA, useMobilityStore } from "../../store/mobilityStore";
import { useUiStore } from "../../store/uiStore";
import { Button } from "../ui";

export function MobilityPanel() {
  const stats = useMobilityStore((s) => s.stats);
  const jobs = useMobilityStore((s) => s.construction);
  const observations = useMobilityStore((s) => s.observations);
  const events = useMobilityStore((s) => s.events);
  const infra = useMobilityStore((s) => s.worlds[s.worldKey] ?? EMPTY_INFRA);
  const [open, setOpen] = useState(false);
  const roads = Object.values(infra.cities).filter((n) => n >= 1).length;
  const metros = Object.values(infra.cities).filter((n) => n === 2).length;
  const bridges = Object.values(infra.bridges).filter(Boolean).length;
  const load = stats?.budget ? Math.min(100, Math.round((stats.active / stats.budget) * 100)) : 0;
  return (
    <section aria-label="City evolution" className="border-t border-white/10 pt-3 text-[11px]">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="heading">City evolution</span>
        <span className="text-surface-300">
          {stats ? `${stats.active} vehicles · ${load}%` : "Starting…"} {open ? "▾" : "▸"}
        </span>
      </button>
      {observations.slice(0, 3).map((observation) => (
        <button
          key={observation.key}
          type="button"
          onClick={() => {
            if (observation.position) {
              useUiStore
                .getState()
                .setCamera({ lookAt: observation.position, distance: 16, nonce: Date.now() });
            }
          }}
          className="mt-2 block w-full rounded border border-amber-300/25 bg-amber-300/5 px-2 py-1.5 text-left text-amber-100"
        >
          {observation.reason === "queue"
            ? `Queue detected · ${observation.queued} slow vehicles`
            : "Road capacity pressure"}
          <span className="mt-0.5 block text-surface-300">
            {observation.key.slice(observation.key.indexOf(":") + 1)} ·{" "}
            {observation.clearSeconds > 0
              ? "Checking recovery…"
              : `Construction in ${Math.ceil(observation.required - observation.seconds)}s`}
          </span>
        </button>
      ))}
      {jobs.map((job) => (
        <div
          key={job.key}
          role="status"
          className="mt-2 rounded border border-amber-300/25 bg-amber-300/10 px-2 py-1.5 text-amber-200"
        >
          🏗 {job.key.slice(job.key.indexOf(":") + 1)} ·{" "}
          {job.kind === "bridge"
            ? "Wider deck + city accesses"
            : job.kind === "metro"
              ? "Metro"
              : "Wider roads"}{" "}
          · {Math.ceil(job.remaining)}s
        </div>
      ))}
      {roads + metros + bridges > 0 && (
        <p className="mt-2 text-cyan-200">
          {roads} wider road networks · {bridges} widened bridges · {metros} metros
        </p>
      )}
      {open && (
        <div className="mt-2 space-y-2 text-surface-300">
          <p>
            Visual traffic budget: {stats?.budget ?? 0}. {stats?.stopped ?? 0} vehicles waiting.
            Excess arrivals are discarded; long jams gradually clear.
          </p>
          <p>
            A local queue of 3 slow vehicles or 80% capacity for 20s triggers expansion. A widened
            bridge deck also widens its city accesses. Continued pressure for 45s opens a metro.
          </p>
          <p>
            Each construction takes 5s. These are real seconds while the tab is visible, even at low
            frame rates.
          </p>
          <p>
            Mark a service as Internet ingress in its details to open a port. Boats follow received
            network throughput.
          </p>
          {events.length > 0 && (
            <ul className="space-y-1 border-l border-cyan-300/30 pl-2">
              {events.map((event) => (
                <li key={event}>{event}</li>
              ))}
            </ul>
          )}
          <p className="text-surface-400">
            Infrastructure is saved in this browser. The traffic is an illustration, not a request
            counter.
          </p>
          <Button
            onClick={() => useMobilityStore.getState().reset()}
            disabled={roads + bridges + jobs.length === 0}
          >
            Reset local construction
          </Button>
        </div>
      )}
    </section>
  );
}
