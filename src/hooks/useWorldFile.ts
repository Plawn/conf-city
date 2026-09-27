import { useCallback } from "react";
import type { World } from "../domain/types";
import { isWorldShape } from "../loaders/loadWorld";
import { useUiStore } from "../store/uiStore";

/** Loading a world from a dropped or picked file, and swapping worlds with a clean view. */
export function useWorldFile({
  setWorld,
  setVisibleCities,
  setSearch,
}: {
  setWorld: (world: World) => void;
  setVisibleCities: (cities: Set<string>) => void;
  setSearch: (value: string) => void;
}) {
  const select = useUiStore((s) => s.select);
  const setCamera = useUiStore((s) => s.setCamera);
  const pushToast = useUiStore((s) => s.pushToast);

  const setWorldAndReset = useCallback(
    (w: World) => {
      setWorld(w);
      setVisibleCities(new Set(w.cities.map((c) => c.id)));
      select(null);
      setCamera(null);
      setSearch("");
    },
    [select, setCamera, setWorld, setVisibleCities, setSearch],
  );

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

  return { setWorldAndReset, handleFile };
}
