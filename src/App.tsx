import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./index.css";
import { DragOverlay } from "./components/DragOverlay";
import { LogPanel } from "./components/LogPanel";
import { NodeDrawer } from "./components/NodeDrawer";
import { AttentionPanel } from "./components/panels/AttentionPanel";
import { CitiesPanel, type CityRow } from "./components/panels/CitiesPanel";
import { DataPanel } from "./components/panels/DataPanel";
import { LegendPanel } from "./components/panels/LegendPanel";
import { LightingPanel } from "./components/panels/LightingPanel";
import { MobilityPanel } from "./components/panels/MobilityPanel";
import { SearchPanel } from "./components/panels/SearchPanel";
import { type ConsumerRow, TopConsumersPanel } from "./components/panels/TopConsumersPanel";
import { StatusBar } from "./components/StatusBar";
import { worldIdentity } from "./components/traffic/worldRoutes";
import { GlassPanel, ToastHost } from "./components/ui";
import { WorldScene } from "./components/WorldScene";
import sampleData from "./data/sample.json";
import { biomeSource, resolveBiomes } from "./domain/biome";
import { cityUsage, cpuSaturation, memSaturation, rankValue } from "./domain/metrics";
import { nodeAddress } from "./domain/nodeStyle";
import type { City, GraphNode, PositionedNode, ResolvedNode, World } from "./domain/types";
import { useAlerts } from "./hooks/useAlerts";
import { readHash, useHashState } from "./hooks/useHashState";
import { type ShortcutHandlers, useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useTelemetryStream } from "./hooks/useTelemetryStream";
import { layoutWorld } from "./layout/layoutWorld";
import { fitAllTarget, fitCityTarget, nodeTarget, resetTarget } from "./lib/cameraTargets";
import { buildDiscoveredNodes } from "./loaders/buildDiscoveredNodes";
import { GraphValidationError, isWorldShape, loadWorld } from "./loaders/loadWorld";
import { useMobilityStore } from "./store/mobilityStore";
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
  const setLogPanelOpen = useUiStore((s) => s.setLogPanelOpen);
  const pushToast = useUiStore((s) => s.pushToast);
  const viewMode = useUiStore((s) => s.viewMode);

  const {
    nodes: staticNodes,
    links: staticLinks,
    error: worldError,
  } = useMemo(() => {
    try {
      const loaded = loadWorld(world);
      return { nodes: loaded.nodes, links: loaded.links, error: null as string | null };
    } catch (e) {
      const error = e instanceof GraphValidationError ? e.message : String(e);
      return { nodes: [] as ResolvedNode[], links: [], error };
    }
  }, [world]);

  useEffect(() => {
    if (worldError) {
      pushToast({
        tone: "danger",
        title: "Invalid world",
        message: worldError,
        durationMs: 10_000,
      });
    }
  }, [worldError, pushToast]);

  // Telemetry without provider-hidden nodes (agents, exporters…): drives counts, alerts and the scene.
  const telemetry = useMemo(() => {
    let hasHidden = false;
    for (const m of nodeMeta.values()) {
      if (m.hidden) {
        hasHidden = true;
        break;
      }
    }
    if (!hasHidden) {
      return rawTelemetry;
    }
    const out = new Map(rawTelemetry);
    for (const [addr, m] of nodeMeta) {
      if (m.hidden) {
        out.delete(addr);
      }
    }
    return out;
  }, [rawTelemetry, nodeMeta]);

  const knownAddresses = useMemo(() => {
    const set = new Set<string>();
    for (const city of world.cities) {
      for (const node of city.nodes) {
        set.add(`${city.id}/${node.id}`);
      }
    }
    return set;
  }, [world]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the version changes only when telemetry keys change; depending on the Map would relayout on every metric tick.
  const { discoveredNodes, discoveredCities, discoveredLinks } = useMemo(() => {
    const result = buildDiscoveredNodes(
      new Set(telemetry.keys()),
      knownAddresses,
      world.cities,
      nodeMeta,
    );
    return {
      discoveredNodes: result.nodes,
      discoveredCities: result.cities,
      discoveredLinks: result.links,
    };
  }, [telemetryKeysVersion, knownAddresses, nodeMeta, world.cities]);

  const links = useMemo(() => [...staticLinks, ...discoveredLinks], [staticLinks, discoveredLinks]);

  const allCities: City[] = useMemo(
    () => [
      ...world.cities,
      ...discoveredCities.map((dc) => ({
        id: dc.id,
        name: dc.name,
        description: "Auto-discovered",
        nodes: [] as GraphNode[],
      })),
    ],
    [world.cities, discoveredCities],
  );

  // Biomes move with the same inputs as the layout (node keys, city meta), so
  // resolving them here costs no extra re-layout — and `layoutWorld` shapes each
  // shore with its biome, so it has to know before it lays anything out.
  const biomes = useMemo(
    () => resolveBiomes(allCities, [...staticNodes, ...discoveredNodes], cityMeta),
    [allCities, staticNodes, discoveredNodes, cityMeta],
  );

  // Identity of the loaded world: the key the mobility store (and its ingress
  // overrides) is scoped by. Computed once here, handed down to `WorldScene`.
  const worldKey = useMemo(() => worldIdentity(world), [world]);
  const ingressOverrides = useMobilityStore((s) => s.ingress);

  // An ingress service *is* the island's port: it must be known before anything
  // is laid out, since `layoutWorld` holds those nodes out of the footprint hull
  // and puts them back on the shoreline (see `layout/harbour.ts`). Priority:
  // the UI checkbox, then the provider label, then the JSON.
  const ingressAddresses = useMemo(() => {
    const set = new Set<string>();
    for (const n of [...staticNodes, ...discoveredNodes]) {
      const addr = nodeAddress(n);
      const override = ingressOverrides[`${worldKey}:${addr}`];
      if (override ?? nodeMeta.get(addr)?.ingress ?? n.ingress ?? false) {
        set.add(addr);
      }
    }
    return set;
  }, [staticNodes, discoveredNodes, ingressOverrides, worldKey, nodeMeta]);

  const worldLayout = useMemo(
    () =>
      layoutWorld(
        allCities.map((c) => c.id),
        staticNodes,
        links,
        discoveredNodes,
        biomes,
        ingressAddresses,
      ),
    [allCities, staticNodes, links, discoveredNodes, biomes, ingressAddresses],
  );
  const nodes = worldLayout.nodes;
  const nodeByAddr = useMemo(() => new Map(nodes.map((n) => [nodeAddress(n), n])), [nodes]);
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

  const setWorldAndReset = useCallback(
    (w: World) => {
      setWorld(w);
      setVisibleCities(new Set(w.cities.map((c) => c.id)));
      select(null);
      setCamera(null);
      setSearch("");
    },
    [select, setCamera],
  );

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

  const focusNode = useCallback(
    (node: PositionedNode) => {
      select(nodeAddress(node));
      setCamera(nodeTarget(node));
      setSearch("");
    },
    [select, setCamera],
  );

  const selectAddr = useCallback(
    (addr: string) => {
      const n = nodeByAddr.get(addr);
      if (!n) {
        return;
      }
      setVisibleCities((prev) => (prev.has(n.cityId) ? prev : new Set([...prev, n.cityId])));
      select(addr);
      setCamera(nodeTarget(n));
    },
    [nodeByAddr, select, setCamera],
  );

  const focusCity = useCallback(
    (cityId: string) => {
      const t = fitCityTarget(worldLayout, cityId);
      if (t) {
        setCamera(t);
      }
    },
    [worldLayout, setCamera],
  );

  const handleNodeClick = useCallback(
    (pos: [number, number, number]) => {
      setCamera({ lookAt: [...pos], nonce: Date.now() });
    },
    [setCamera],
  );

  const resetView = useCallback(() => setCamera(resetTarget()), [setCamera]);
  const fitAll = useCallback(
    () => setCamera(fitAllTarget(worldLayout, visibleCities)),
    [worldLayout, visibleCities, setCamera],
  );

  const shortcuts = useMemo<ShortcutHandlers>(
    () => ({
      onSearch: () => searchRef.current?.focus(),
      onEscape: () => {
        const s = useUiStore.getState();
        if (s.selectedNode) {
          s.select(null);
        } else if (s.logPanel.open) {
          s.setLogPanelOpen(false);
        } else {
          setSearch("");
        }
      },
      onReset: resetView,
      onFit: fitAll,
      onToggleLogs: () => setLogPanelOpen(!useUiStore.getState().logPanel.open),
    }),
    [resetView, fitAll, setLogPanelOpen],
  );
  useKeyboardShortcuts(shortcuts);

  const handleFile = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const json = JSON.parse(e.target?.result as string);
          if (!isWorldShape(json)) {
            pushToast({
              tone: "danger",
              title: "Invalid file",
              message: "Expected { cities: [{ id, nodes }] }",
            });
            return;
          }
          setWorldAndReset(json);
          pushToast({
            tone: "ok",
            title: "World loaded",
            message: `${file.name} · ${json.cities.length} cities`,
          });
        } catch {
          pushToast({ tone: "danger", title: "Invalid JSON file" });
        }
      };
      reader.onerror = () => pushToast({ tone: "danger", title: "Failed to read file" });
      reader.readAsText(file);
    },
    [setWorldAndReset, pushToast],
  );

  const cityRows = useMemo<CityRow[]>(
    () =>
      allCities.map((city) => {
        const cityNodes = nodes.filter((n) => n.cityId === city.id);
        let down = 0,
          degraded = 0;
        const cityTelemetry = cityNodes.map((n) => telemetry.get(nodeAddress(n)));
        for (const t of cityTelemetry) {
          if (t?.liveness === "down") {
            down++;
          } else if (t?.liveness === "degraded") {
            degraded++;
          }
        }
        const usage = cityTelemetry.some(Boolean)
          ? cityUsage(cityTelemetry, cityMeta.get(city.id), cityMetrics.get(city.id))
          : undefined;
        const biome = worldLayout.cities.get(city.id)?.biome;
        return {
          city,
          count: cityNodes.length,
          isDiscovered: discoveredCities.some((dc) => dc.id === city.id),
          down,
          degraded,
          usage,
          ...(biome
            ? { biome: { id: biome, source: biomeSource(city, cityMeta.get(city.id)) } }
            : {}),
        };
      }),
    [allCities, nodes, telemetry, cityMeta, cityMetrics, discoveredCities, worldLayout],
  );

  // Top consumers for the active metric (health → memory), normalised per city
  const topConsumers = useMemo<ConsumerRow[]>(() => {
    const mode = viewMode === "health" ? "memory" : viewMode;
    const cityMaxValue = new Map<string, number>();
    const rows: ConsumerRow[] = [];
    for (const n of nodes) {
      if (!visibleCities.has(n.cityId)) {
        continue;
      }
      const m = telemetry.get(nodeAddress(n))?.metrics;
      const value = rankValue(mode, m);
      if (value == null) {
        continue;
      }
      cityMaxValue.set(n.cityId, Math.max(cityMaxValue.get(n.cityId) ?? 0, value));
      const saturation =
        mode === "cpu"
          ? m?.cpuLimit
            ? cpuSaturation(m)
            : undefined
          : mode === "memory"
            ? memSaturation(m)
            : undefined;
      rows.push({
        addr: nodeAddress(n),
        label: n.label,
        cityId: n.cityId,
        value,
        ratio: 0,
        saturation,
      });
    }
    rows.sort((a, b) => b.value - a.value);
    return rows.slice(0, 5).map((r) => ({
      ...r,
      ratio: (cityMaxValue.get(r.cityId) ?? 0) > 0 ? r.value / cityMaxValue.get(r.cityId)! : 0,
    }));
  }, [nodes, telemetry, visibleCities, viewMode]);

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
