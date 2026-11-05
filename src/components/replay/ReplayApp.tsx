import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import "../../index.css";
import { activeKey, parseScenario, presenceAt, type Timeline } from "../../domain/scenario";
import { useReplayBase, useReplayScene } from "../../hooks/useReplayModel";
import { useLightingStore } from "../../store/lightingStore";
import {
  CAPTURE_MODE,
  CINEMA_MODE,
  REPLAY_URL,
  replayCommit,
  replayPresence,
  useReplayStore,
} from "../../store/replayStore";
import { WorldScene } from "../WorldScene";
import { OpenScenario, ReplayBar } from "./ReplayBar";
import { ReplayBlasts } from "./ReplayBlasts";
import { ReplayDriver, RisingCity } from "./ReplayDriver";
import { ReplayOverlay } from "./ReplayOverlay";

/** `?replay=<url>` fetches the scenario and plays it; `?replay` alone waits for a file. */
export function ReplayApp() {
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Remounts the player so a new scenario starts from a clean scene. */
  const [loads, setLoads] = useState(0);
  const play = useCallback((json: unknown) => {
    const tl = parseScenario(json);
    const store = useReplayStore.getState();
    store.setT(0);
    store.setPlaying(!CAPTURE_MODE);
    store.setActiveKey(activeKey(presenceAt(tl, 0)));
    if (tl.scenario.sunTime) {
      useLightingStore.getState().preview(Date.parse(tl.scenario.sunTime));
    }
    setError(null);
    setTimeline(tl);
    setLoads((n) => n + 1);
  }, []);
  const open = useCallback(
    (file: File) => {
      file
        .text()
        .then((text) => play(JSON.parse(text)))
        .catch((e: unknown) => setError(`${file.name}: ${e instanceof Error ? e.message : e}`));
    },
    [play],
  );
  useEffect(() => {
    if (!REPLAY_URL) {
      return;
    }
    fetch(REPLAY_URL)
      .then((r) => {
        if (!r.ok) {
          throw new Error(`${REPLAY_URL}: HTTP ${r.status}`);
        }
        return r.json();
      })
      .then(play)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [play]);

  if (!timeline) {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-surface-950 p-6 text-white">
        {error && <pre className="max-w-2xl whitespace-pre-wrap text-sm text-red-300">{error}</pre>}
        {(error || !REPLAY_URL) && <OpenScenario onOpen={open} />}
      </div>
    );
  }
  return (
    <>
      <ReplayPlayer key={loads} timeline={timeline} onOpen={open} />
      {error && (
        <button
          type="button"
          className="glass-morphic-subtle absolute inset-x-4 top-4 z-40 rounded-2xl px-4 py-2 text-left text-sm text-red-200"
          onClick={() => setError(null)}
        >
          <pre className="whitespace-pre-wrap">{error}</pre>
        </button>
      )}
    </>
  );
}

const presenceOf = (cityId: string) => replayPresence.cities.get(cityId) ?? 0;

function ReplayPlayer({ timeline, onOpen }: { timeline: Timeline; onOpen: (file: File) => void }) {
  const base = useReplayBase(timeline);
  const key = useReplayStore((s) => s.activeKey);
  const scene = useReplayScene(timeline, base, key);
  // Children's layout effects (building registrations) have run by now.
  useLayoutEffect(() => {
    replayCommit.key = key;
  }, [key]);
  return (
    <div className="relative h-screen w-screen">
      <WorldScene
        worldKey={base.worldKey}
        cities={scene.cities}
        nodes={scene.layout.nodes}
        links={scene.links}
        layout={scene.layout}
        visibleCities={scene.visibleCities}
        cameraTarget={null}
        onNodeClick={() => {}}
        telemetry={scene.telemetry}
        cityMeta={timeline.cityMeta}
        wrapCity={RisingCity}
        cityPresence={presenceOf}
      >
        <ReplayDriver timeline={timeline} shots={base.shots} />
        <ReplayBlasts layout={scene.layout} rampSec={timeline.rampSec} />
      </WorldScene>
      <ReplayOverlay timeline={timeline} />
      {!CINEMA_MODE && <ReplayBar timeline={timeline} onOpen={onOpen} />}
    </div>
  );
}
