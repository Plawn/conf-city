import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ReplayApp } from "./components/replay/ReplayApp";
import { REPLAY_MODE } from "./store/replayStore";

createRoot(document.getElementById("root")!).render(REPLAY_MODE ? <ReplayApp /> : <App />);
