/** Choice table behind the Tweaks panel: one row per overridable budget, no React. */
import type { QualityProfile } from "../domain/quality";
import type { OverrideKey } from "../domain/qualityOverrides";

export type TweakValue = number | boolean;

export interface TweakChoice {
  label: string;
  value: TweakValue;
}

export interface TweakControl {
  key: Exclude<OverrideKey, "maxPixels">;
  label: string;
  choices: TweakChoice[];
}

const ON_OFF: TweakChoice[] = [
  { label: "on", value: true },
  { label: "off", value: false },
];

const numbers = (values: number[]): TweakChoice[] =>
  values.map((value) => ({ label: String(value), value }));

/** Order matches the panel; `maxPixels` is a slider and lives outside this table. */
export const TWEAK_CONTROLS: readonly TweakControl[] = [
  {
    key: "ao",
    label: "AO",
    choices: [{ label: "off", value: 0 }, ...numbers([8, 16, 32])],
  },
  { key: "aoDenoise", label: "Denoise", choices: ON_OFF },
  {
    key: "bloomScale",
    label: "Bloom",
    choices: [
      { label: "off", value: 0 },
      { label: "¼", value: 0.25 },
      { label: "½", value: 0.5 },
      { label: "1", value: 1 },
    ],
  },
  { key: "shadowMapSize", label: "Shadow map", choices: numbers([1024, 2048, 4096]) },
  { key: "shadowHz", label: "Shadow Hz", choices: numbers([2, 4, 6, 12, 30]) },
  { key: "pointLights", label: "Point lights", choices: numbers([32, 96, 256, 1024]) },
  { key: "vehicleSpots", label: "Vehicle spots", choices: numbers([0, 4, 8, 16]) },
  { key: "volume", label: "Volume", choices: ON_OFF },
  { key: "beaconShadow", label: "Beacon shadow", choices: ON_OFF },
  { key: "maxCars", label: "Cars", choices: numbers([60, 120, 240, 480]) },
  { key: "maxTrucks", label: "Trucks", choices: numbers([15, 30, 60, 120]) },
  { key: "maxDpr", label: "Max DPR", choices: numbers([1, 1.5, 2]) },
];

/** The tier's own value for a key, flattening the nested `ao` block. */
export function tierValue(profile: QualityProfile, key: OverrideKey): TweakValue {
  if (key === "ao") {
    return profile.ao.enabled ? profile.ao.samples : 0;
  }
  if (key === "aoDenoise") {
    return profile.ao.denoise;
  }
  return profile[key];
}

/** Same text as the matching choice so the muted tier hint reads like the buttons. */
export function tierValueLabel(control: TweakControl, profile: QualityProfile): string {
  const value = tierValue(profile, control.key);
  const choice = control.choices.find((c) => c.value === value);
  if (choice) {
    return choice.label;
  }
  return typeof value === "boolean" ? (value ? "on" : "off") : String(value);
}

/** SegmentedControl needs string options; `String` round-trips numbers and booleans alike. */
export function choiceId(value: TweakValue): string {
  return String(value);
}
