import { useMemo } from "react";
import { type Change, countAt, monthAt } from "../../domain/replayHud";
import {
  type ChapterState,
  chapterAt,
  chapterStat,
  leapAt,
  type Progress,
  progressAt,
  type RecapStat,
  recapAt,
  recapFigures,
  scenarioStats,
  word,
} from "../../domain/replayStats";
import type { Timeline } from "../../domain/scenario";
import { useReplayStore } from "../../store/replayStore";

/** Seconds a month label takes to slide out for the next. */
const MONTH_FADE = 0.45;

const ease = (x: number) => 1 - (1 - x) ** 3;

/** Seconds a counter takes to roll to its new value. */
const ROLL = 0.3;

const pad2 = (n: number) => String(n).padStart(2, "0");

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

/** Lower-third card opening a chapter: index, title, caption, stat chip. */
function ChapterCard({
  state,
  count,
  stat,
}: {
  state: ChapterState;
  count: number;
  stat: string | null;
}) {
  const { chapter, card, lift } = state;
  return (
    <>
      <div
        className="absolute inset-0 bg-linear-to-tr from-black/55 via-black/10 to-transparent to-60%"
        style={{ opacity: card }}
      />
      <div
        className="absolute bottom-[14%] left-20 max-w-[48rem] drop-shadow-lg"
        style={{ opacity: card, transform: `translateY(${lift * 12}px)` }}
      >
        <div className="text-sm font-medium uppercase tracking-[0.3em] text-surface-300 tabular-nums">
          {pad2(chapter.index + 1)} / {pad2(count)}
        </div>
        <h2 className="mt-2 text-5xl font-semibold leading-tight tracking-tight">
          {chapter.title}
        </h2>
        {chapter.caption && <p className="mt-2 text-xl text-surface-200">{chapter.caption}</p>}
        {stat && (
          <div className="glass-morphic-subtle mt-4 inline-block rounded-full px-4 py-1.5 text-lg font-medium tabular-nums">
            {stat}
          </div>
        )}
      </div>
    </>
  );
}

/** Story-style bar along the bottom: one segment per chapter (intro and outro too), filled to `t`. */
function ProgressLine({
  progress,
  titles,
  label,
}: {
  progress: Progress;
  titles: string[];
  /** Opacity of the current chapter's title (hidden while its card shows). */
  label: number;
}) {
  const { k, markers, current, outro } = progress;
  const edges = [0, ...markers, outro, 1].filter((e, i, all) => i === 0 || e > all[i - 1]!);
  const from = markers[current];
  const title = titles[current];
  return (
    <div className="absolute inset-x-20 bottom-7">
      {from !== undefined && title && label > 0 && (
        <div
          className="absolute bottom-3 whitespace-nowrap text-sm font-medium uppercase tracking-[0.2em] text-surface-100 drop-shadow"
          style={{
            left: `${from * 100}%`,
            transform: `translateX(-${from * 100}%)`,
            opacity: label,
          }}
        >
          {pad2(current + 1)} · {title}
        </div>
      )}
      <div className="relative h-1 drop-shadow">
        {edges.slice(0, -1).map((a, i) => {
          const b = edges[i + 1]!;
          const fill = Math.max(0, Math.min(1, (k - a) / (b - a)));
          return (
            <div
              key={a}
              className="absolute inset-y-0 px-[2px]"
              style={{ left: `${a * 100}%`, width: `${(b - a) * 100}%` }}
            >
              <div
                className={`relative h-full overflow-hidden rounded-full ${a === from ? "bg-white/40" : "bg-white/20"}`}
              >
                <div className="h-full bg-white" style={{ width: `${fill * 100}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Outro: the title again over six figures counting up. */
function RecapCard({
  title,
  figures,
  shown,
  opacity,
  numbers,
}: {
  title: string;
  figures: RecapStat[];
  shown: number[];
  opacity: number;
  numbers: Intl.NumberFormat;
}) {
  return (
    <div
      className="absolute inset-0 flex items-center justify-center bg-black/45"
      style={{ opacity }}
    >
      <div
        className="glass-morphic-thick rounded-3xl px-16 py-12 text-center"
        style={{
          background: "color-mix(in oklab, #0c0d1f 88%, transparent)",
          transform: `translateY(${(1 - ease(opacity)) * 12}px)`,
        }}
      >
        <h2 className="text-5xl font-semibold tracking-tight">{title}</h2>
        <div className="mt-10 grid grid-cols-3 gap-x-20 gap-y-10">
          {figures.map((f, i) => (
            <div key={f.key} className="min-w-[12rem]">
              <div className="text-6xl font-semibold tabular-nums">
                {numbers.format(shown[i] ?? 0)}
              </div>
              <div className="mt-1 text-base text-surface-200">{f.label}</div>
              {f.detail && (
                <div className="mt-0.5 text-base font-medium capitalize text-accent-300">
                  {f.detail}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Title card during the intro, chapter cards, the date and what stands, progress, recap. */
export function ReplayOverlay({ timeline }: { timeline: Timeline }) {
  // 30 Hz: one render per exported frame, cheap enough live for a handful of spans.
  const t = useReplayStore((s) => Math.floor(s.t * 30) / 30);
  const scn = timeline.scenario;
  const { monthFmt, numbers, figures, stats, titles } = useMemo(
    () => ({
      monthFmt: new Intl.DateTimeFormat(scn.lang, { month: "long", year: "numeric" }),
      numbers: new Intl.NumberFormat(scn.lang),
      figures: recapFigures(scenarioStats(timeline)),
      stats: timeline.chapters.map((c) => chapterStat(timeline, c)),
      titles: timeline.chapters.map((c) => c.title),
    }),
    [timeline, scn.lang],
  );
  const intro = scn.introSec ?? 3;
  const titleOpacity = Math.max(0, Math.min(1, (intro - t) / 0.8));
  const cities = countAt(timeline, t, ROLL, "cities");
  const clouds = countAt(timeline, t, ROLL, "clouds");
  const nodes = countAt(timeline, t, ROLL, "nodes");
  const leap = leapAt(timeline, t);
  // While the date leaps the month shows plain: a slide per month would strobe.
  const month =
    leap > 0
      ? { current: monthAt(timeline, t, 0).current, previous: null, k: 1 }
      : monthAt(timeline, t, MONTH_FADE);
  const k = ease(month.k);
  const chapter = chapterAt(timeline, t);
  const progress = progressAt(timeline, t);
  const recap = recapAt(timeline, t, figures);
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
      {chapter && chapter.card > 0 && (
        <ChapterCard
          state={chapter}
          count={timeline.chapters.length}
          stat={stats[chapter.chapter.index] ?? null}
        />
      )}
      {recap && recap.opacity > 0 && (
        <RecapCard
          title={scn.title}
          figures={figures}
          shown={recap.shown}
          opacity={recap.opacity}
          numbers={numbers}
        />
      )}
      <div className="glass-morphic-subtle absolute left-6 top-6 rounded-2xl px-5 py-3">
        <div className="relative flex items-center gap-2 overflow-hidden text-2xl font-semibold capitalize tabular-nums">
          <div className="relative">
            <div style={{ opacity: k, transform: `translateY(${(1 - k) * 60}%)` }}>
              {monthFmt.format(month.current)}
            </div>
            {month.previous && (
              <div
                className="absolute inset-0"
                style={{ opacity: 1 - k, transform: `translateY(${-k * 60}%)` }}
                aria-hidden
              >
                {monthFmt.format(month.previous)}
              </div>
            )}
          </div>
          {leap > 0 && (
            <span className="text-base text-surface-300" style={{ opacity: leap }}>
              ⏩
            </span>
          )}
        </div>
        <div className="mt-1 flex gap-4 text-sm text-surface-200 tabular-nums">
          <span>
            <Rolling change={cities} /> {word(timeline, "server", cities.current)}
          </span>
          {(clouds.current > 0 || clouds.previous) && (
            <span>
              <Rolling change={clouds} /> {word(timeline, "cloud", clouds.current)}
            </span>
          )}
          <span>
            <Rolling change={nodes} /> {word(timeline, "service", nodes.current)}
          </span>
        </div>
      </div>
      <ProgressLine progress={progress} titles={titles} label={1 - (chapter?.card ?? 0)} />
    </div>
  );
}
