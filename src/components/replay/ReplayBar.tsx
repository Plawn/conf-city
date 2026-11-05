import { useMemo, useRef } from "react";
import type { Timeline } from "../../domain/scenario";
import { useReplayStore } from "../../store/replayStore";

const SPEEDS = [0.25, 0.5, 1, 2, 4];

/** Transport for tuning a scenario: play, scrub (event ticks, chapter jumps), speed, camera mode. */
export function ReplayBar({
  timeline,
  onOpen,
}: {
  timeline: Timeline;
  onOpen: (file: File) => void;
}) {
  const t = useReplayStore((s) => s.t);
  const playing = useReplayStore((s) => s.playing);
  const speed = useReplayStore((s) => s.speed);
  const director = useReplayStore((s) => s.director);
  const { setT, setPlaying, setSpeed, setDirector } = useReplayStore.getState();
  const total = timeline.totalSec;
  const ticks = useMemo(
    () => [...new Set(timeline.events.map((e) => Math.round((e.at / total) * 1000) / 10))],
    [timeline, total],
  );
  const toggle = () => {
    if (!playing && t >= total) {
      setT(0);
    }
    setPlaying(!playing);
  };
  return (
    <div className="glass-morphic-subtle absolute inset-x-4 bottom-4 z-30 flex items-center gap-3 rounded-2xl px-4 py-2 text-sm text-white">
      <button
        type="button"
        className="glass-button w-16 rounded px-2 py-1"
        onClick={toggle}
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? "Pause" : "Play"}
      </button>
      <span className="w-24 font-mono tabular-nums text-surface-200">
        {t.toFixed(1)} / {total.toFixed(0)} s
      </span>
      <div className="relative flex-1">
        <input
          type="range"
          className="w-full"
          min={0}
          max={total}
          step={0.01}
          value={t}
          onChange={(e) => setT(Number(e.target.value))}
          aria-label="Replay position"
        />
        <div className="pointer-events-none absolute inset-x-0 -bottom-1 h-1.5">
          {ticks.map((pct) => (
            <span
              key={pct}
              className="absolute h-1.5 w-px bg-accent-400"
              style={{ left: `${pct}%` }}
            />
          ))}
        </div>
        {timeline.chapters.map((ch) => (
          <button
            key={ch.index}
            type="button"
            title={ch.title}
            aria-label={`Chapter ${ch.index + 1}: ${ch.title}`}
            className="absolute -top-2.5 h-2.5 w-2.5 -translate-x-1/2 rounded-full border border-white/70 bg-surface-900 hover:bg-white"
            style={{ left: `${(ch.at / total) * 100}%` }}
            onClick={() => setT(ch.at)}
          />
        ))}
      </div>
      <select
        className="glass-button rounded px-2 py-1"
        value={speed}
        onChange={(e) => setSpeed(Number(e.target.value))}
        aria-label="Speed"
      >
        {SPEEDS.map((s) => (
          <option key={s} value={s}>
            {s}×
          </option>
        ))}
      </select>
      <label className="flex items-center gap-1.5">
        <input type="checkbox" checked={director} onChange={(e) => setDirector(e.target.checked)} />
        Director
      </label>
      <OpenScenario onOpen={onOpen} />
    </div>
  );
}

/** Picks a scenario JSON from disk; it plays in place of the current one. */
export function OpenScenario({ onOpen }: { onOpen: (file: File) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        className="glass-button whitespace-nowrap rounded px-2 py-1"
        onClick={() => input.current?.click()}
      >
        Open scenario…
      </button>
      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Cleared so picking the same file again (after editing it) reloads it.
          e.target.value = "";
          if (file) {
            onOpen(file);
          }
        }}
      />
    </>
  );
}
