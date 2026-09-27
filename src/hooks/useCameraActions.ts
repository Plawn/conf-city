import { type RefObject, useCallback, useMemo } from "react";
import { nodeAddress } from "../domain/nodeStyle";
import type { PositionedNode } from "../domain/types";
import type { WorldLayout } from "../layout/types";
import { fitAllTarget, fitCityTarget, nodeTarget, resetTarget } from "../lib/cameraTargets";
import { useUiStore } from "../store/uiStore";
import { type ShortcutHandlers, useKeyboardShortcuts } from "./useKeyboardShortcuts";

/** Focus, selection and framing callbacks, and the keyboard shortcuts bound to them. */
export function useCameraActions({
  nodeByAddr,
  worldLayout,
  visibleCities,
  setVisibleCities,
  setSearch,
  searchRef,
}: {
  nodeByAddr: Map<string, PositionedNode>;
  worldLayout: WorldLayout;
  visibleCities: Set<string>;
  setVisibleCities: (update: (prev: Set<string>) => Set<string>) => void;
  setSearch: (value: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
}) {
  const select = useUiStore((s) => s.select);
  const setCamera = useUiStore((s) => s.setCamera);
  const setLogPanelOpen = useUiStore((s) => s.setLogPanelOpen);

  const focusNode = useCallback(
    (node: PositionedNode) => {
      select(nodeAddress(node));
      setCamera(nodeTarget(node));
      setSearch("");
    },
    [select, setCamera, setSearch],
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
    [nodeByAddr, select, setCamera, setVisibleCities],
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
    [resetView, fitAll, setLogPanelOpen, setSearch, searchRef],
  );
  useKeyboardShortcuts(shortcuts);

  return { focusNode, selectAddr, focusCity, handleNodeClick, resetView, fitAll };
}
