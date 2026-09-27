import { expect, test } from "bun:test";
import { QUALITY_PROFILES } from "@/domain/quality";
import { selectProfile, useUiStore } from "@/store/uiStore";

test("tweaks merge on top of the tier and keep a stable identity", () => {
  const s = useUiStore.getState();
  s.setQuality("high");
  expect(selectProfile(useUiStore.getState())).toBe(QUALITY_PROFILES.high);
  s.setRenderOverride("ao", 0);
  const tweaked = selectProfile(useUiStore.getState());
  expect(tweaked.ao.enabled).toBe(false);
  expect(tweaked.vehicleSpots).toBe(16);
  // Unrelated store updates keep the same profile object.
  s.pushToast({ tone: "info", title: "x" });
  expect(selectProfile(useUiStore.getState())).toBe(tweaked);
  // The override follows a tier change.
  s.setQuality("eco");
  const eco = selectProfile(useUiStore.getState());
  expect(eco.tier).toBe("eco");
  expect(eco.ao.enabled).toBe(false);
  expect(useUiStore.getState().renderOverrides).toEqual({ ao: 0 });
  s.setRenderOverride("ao", undefined);
  expect(selectProfile(useUiStore.getState())).toBe(QUALITY_PROFILES.eco);
  s.setRenderOverride("volume", true);
  s.setRenderOverride("maxCars", 60);
  expect(selectProfile(useUiStore.getState())).toMatchObject({ volume: true, maxCars: 60 });
  s.resetRenderOverrides();
  expect(useUiStore.getState().renderOverrides).toEqual({});
  expect(selectProfile(useUiStore.getState())).toBe(QUALITY_PROFILES.eco);
  s.setQuality("auto");
});
