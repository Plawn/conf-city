import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./index.css";
import { DragOverlay } from "./components/DragOverlay";
import { LogPanel } from "./components/LogPanel";
import { NodeDrawer } from "./components/NodeDrawer";
import { AttentionPanel } from "./components/panels/AttentionPanel";
import { CitiesPanel } from "./components/panels/CitiesPanel";
import { DataPanel } from "./components/panels/DataPanel";
import { LegendPanel } from "./components/panels/LegendPanel";
import { LightingPanel } from "./components/panels/LightingPanel";
import { MobilityPanel } from "./components/panels/MobilityPanel";
import { SearchPanel } from "./components/panels/SearchPanel";
import { TopConsumersPanel } from "./components/panels/TopConsumersPanel";
import { StatusBar } from "./components/StatusBar";
import { GlassPanel, ToastHost } from "./components/ui";
import { WorldScene } from "./components/WorldScene";
import sampleData from "./data/sample.json";
import {
  type CityRow,
  type ConsumerRow,
  cityRows as cityRowsOf,
  topConsumers as topConsumersOf,
} from "./domain/panelRows";
import type { World } from "./domain/types";
import { useAlerts } from "./hooks/useAlerts";
import { useCameraActions } from "./hooks/useCameraActions";
import { readHash, useHashState } from "./hooks/useHashState";
import { useTelemetryStream } from "./hooks/useTelemetryStream";
import { useWorldFile } from "./hooks/useWorldFile";
import { useWorldModel } from "./hooks/useWorldModel";
import { nodeTarget } from "./lib/cameraTargets";
import { useUiStore } from "./store/uiStore";

export function App() {
  const [world, setWorld] = useState<World>(sampleData as World);
  const [search, setSearch] = useState("");
  const [dragDepth, setDragDepth] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const initialHash = useRef(readHash());

  const {
    telemetry: rawTelemetry,
    nodeMeta,
    cityMeta,
    cityMetrics,
    telemetryKeysVersion,
    connected,
    providers,
    logs,
    history,
    historyVersion,
    lastUpdateAt,
    requestSnapshot,
    subscribeLogs,
    unsubscribeLogs,
    canQueryLogs,
    queryLogs,
  } = useTelemetryStream();

  const selectedNode = useUiStore((s) => s.selectedNode);
  const select = useUiStore((s) => s.select);
  const cameraTarget = useUiStore((s) => s.cameraTarget);
  const setCamera = useUiStore((s) => s.setCamera);
  const pushToast = useUiStore((s) => s.pushToast);
  const viewMode = useUiStore((s) => s.viewMode);

  const {
    telemetry,
    discoveredCities,
    links,
    allCities,
    worldKey,
    worldLayout,
    nodes,
    nodeByAddr,
  } = useWorldModel(world, { rawTelemetry, nodeMeta, cityMeta, telemetryKeysVersion });
  const labelFor = useCallback((addr: string) => nodeByAddr.get(addr)?.label ?? addr, [nodeByAddr]);

  const [visibleCities, setVisibleCities] = useState(() => {
    const fromHash = initialHash.current.cities;
    const all = world.cities.map((c) => c.id);
    return new Set(fromHash ? all.filter((id) => fromHash.includes(id)) : all);
  });

  // Auto-add discovered cities to visible set
  useEffect(() => {
    if (discoveredCities.length === 0) {
      return;
    }
    setVisibleCities((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const dc of discoveredCities) {
        if (!next.has(dc.id)) {
          next.add(dc.id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [discoveredCities]);

  // Restore selected node from URL hash once it exists
  useEffect(() => {
    const addr = initialHash.current.node;
    if (addr && nodeByAddr.has(addr)) {
      initialHash.current.node = undefined;
      select(addr);
      setCamera(nodeTarget(nodeByAddr.get(addr)!));
    }
  }, [nodeByAddr, select, setCamera]);

  useHashState({ cities: [...visibleCities], node: selectedNode ?? undefined });

  // Alerts → toasts
  const { alerts, clear: clearAlerts } = useAlerts(telemetry, {
    onAlert: (a) =>
      pushToast({ tone: a.tone, title: labelFor(a.node), message: a.message, node: a.node }),
  });

  const { setWorldAndReset, handleFile } = useWorldFile({ setWorld, setVisibleCities, setSearch });

  const toggleCity = useCallback((cityId: string) => {
    setVisibleCities((prev) => {
      const next = new Set(prev);
      if (next.has(cityId)) {
        next.delete(cityId);
      } else {
        next.add(cityId);
      }
      return next;
    });
  }, []);

  const searchResults = useMemo(() => {
    if (search.length < 2) {
      return [];
    }
    const q = search.toLowerCase();
    return nodes
      .filter(
        (n) =>
          n.label.toLowerCase().includes(q) ||
          n.id.toLowerCase().includes(q) ||
          n.description?.toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [search, nodes]);

  const { focusNode, selectAddr, focusCity, handleNodeClick, resetView, fitAll } = useCameraActions(
    {
      nodeByAddr,
      worldLayout,
      visibleCities,
      setVisibleCities,
      setSearch,
      searchRef,
    },
  );

  const cityRows = useMemo<CityRow[]>(
    () =>
      cityRowsOf(
        allCities,
        nodes,
        telemetry,
        cityMeta,
        cityMetrics,
        discoveredCities,
        worldLayout.cities,
      ),
    [allCities, nodes, telemetry, cityMeta, cityMetrics, discoveredCities, worldLayout],
  );

  const topConsumers = useMemo<ConsumerRow[]>(
    () => topConsumersOf(nodes, telemetry, visibleCities, viewMode),
    [nodes, telemetry, visibleCities, viewMode],
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: this application-wide drop target supplements the accessible file picker.
    <div
      className="relative h-screen w-screen"
      onDragEnter={(e) => {
        e.preventDefault();
        setDragDepth((d) => d + 1);
      }}
      onDragLeave={() => setDragDepth((d) => Math.max(0, d - 1))}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        setDragDepth(0);
        const file = e.dataTransfer.files[0];
        if (file) {
          handleFile(file);
        }
      }}
    >
      <WorldScene
        worldKey={worldKey}
        cities={allCities}
        nodes={nodes}
        links={links}
        layout={worldLayout}
        visibleCities={visibleCities}
        cameraTarget={cameraTarget}
        onNodeClick={handleNodeClick}
        onBackgroundClick={() => select(null)}
        telemetry={telemetry}
        cityMeta={cityMeta}
        cityMetrics={cityMetrics}
      />

      {/* Left panel: search + cities + data */}
      <GlassPanel className="glass-scroll absolute bottom-4 left-4 top-36 z-20 flex w-[270px] max-w-[calc(100vw-2rem)] flex-col gap-3 divide-y divide-white/10 overflow-y-auto sm:top-24 [&>*]:shrink-0 [&>*+*]:pt-3">
        <SearchPanel
          ref={searchRef}
          value={search}
          onChange={setSearch}
          results={searchResults}
          onPick={focusNode}
        />
        <AttentionPanel
          nodes={nodes}
          cities={allCities}
          telemetry={telemetry}
          connected={connected}
          onPick={selectAddr}
        />
        <LightingPanel />
        <MobilityPanel />
        <CitiesPanel
          rows={cityRows}
          visibleCities={visibleCities}
          onToggle={toggleCity}
          onFocus={focusCity}
        />
        <TopConsumersPanel rows={topConsumers} onPick={selectAddr} />
        <DataPanel
          onFile={handleFile}
          canReset={world !== (sampleData as World)}
          onReset={() => setWorldAndReset(sampleData as World)}
        />
        <details>
          <summary className="heading cursor-pointer rounded py-1 focus-visible:outline-2 focus-visible:outline-accent-400">
            Legend & visual cues
          </summary>
          <div className="mt-2">
            <LegendPanel />
          </div>
        </details>
      </GlassPanel>

      <StatusBar
        telemetry={telemetry}
        connected={connected}
        providers={providers}
        lastUpdateAt={lastUpdateAt}
        alerts={alerts}
        onClearAlerts={clearAlerts}
        onRefresh={requestSnapshot}
        onReset={resetView}
        onFit={fitAll}
        onSelectNode={selectAddr}
        labelFor={labelFor}
      />

      <NodeDrawer
        nodes={nodes}
        telemetry={telemetry}
        history={history}
        historyVersion={historyVersion}
      />

      <LogPanel
        logs={logs}
        subscribeLogs={subscribeLogs}
        unsubscribeLogs={unsubscribeLogs}
        connected={connected}
        canQueryLogs={canQueryLogs}
        queryLogs={queryLogs}
      />

      <ToastHost onToastClick={(t) => t.node && selectAddr(t.node)} />
      <DragOverlay active={dragDepth > 0} />
    </div>
  );
}

export default App;
