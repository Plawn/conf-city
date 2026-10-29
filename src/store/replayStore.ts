import { create } from "zustand";
import type { Presence } from "../domain/scenario";

/** `?replay=<scenario url>`: the app plays a scenario instead of live telemetry. */
export const REPLAY_PARAMS = new URLSearchParams(window.location.search);
export const REPLAY_URL = REPLAY_PARAMS.get("replay");
export const REPLAY_MODE = REPLAY_URL != null;
/** Chrome-less framing for recording. */
export const CINEMA_MODE = REPLAY_PARAMS.get("cinema") === "1";
/** Headless export: time is set by the capture script, never by the frame clock. */
export const CAPTURE_MODE = REPLAY_PARAMS.get("capture") === "1";

/** Written once per frame by `ReplayDriver`, read by the animations: no React render per frame. */
export const replayPresence: Presence = {
  cities: new Map(),
  nodes: new Map(),
  links: new Map(),
  blasts: new Map(),
};

/** Active set the React tree last committed: a captured frame waits for it. */
export const replayCommit = { key: "" };

interface ReplayState {
  /** Video second. */
  t: number;
  playing: boolean;
  speed: number;
  /** Camera follows the planned shots; off = free orbit. */
  director: boolean;
  /** Changes only when something enters or leaves the scene (`activeKey`). */
  activeKey: string;
  setT: (t: number) => void;
  setPlaying: (playing: boolean) => void;
  setSpeed: (speed: number) => void;
  setDirector: (director: boolean) => void;
  setActiveKey: (key: string) => void;
}

export const useReplayStore = create<ReplayState>((set) => ({
  t: 0,
  playing: !CAPTURE_MODE,
  speed: 1,
  director: true,
  activeKey: "",
  setT: (t) => set({ t }),
  setPlaying: (playing) => set({ playing }),
  setSpeed: (speed) => set({ speed }),
  setDirector: (director) => set({ director }),
  setActiveKey: (activeKey) => set({ activeKey }),
}));
