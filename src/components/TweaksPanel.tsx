/** Per-budget overrides on top of the quality tier, for A/B-ing a setting by eye. */
import { type CSSProperties, useEffect, useState } from "react";
import { QUALITY_PROFILES } from "../domain/quality";
import { type OverrideKey, overrideCount, type QualityOverrides } from "../domain/qualityOverrides";
import { useQualityTier, useUiStore } from "../store/uiStore";
import { choiceId, TWEAK_CONTROLS, type TweakControl, tierValueLabel } from "./tweakControls";
import { Button, SegmentedControl } from "./ui";

const MIN_MPX = 0.5;
const MAX_MPX = 5;

export function TweaksPanel() {
  const overrides = useUiStore((s) => s.renderOverrides);
  const setRenderOverride = useUiStore((s) => s.setRenderOverride);
  const resetRenderOverrides = useUiStore((s) => s.resetRenderOverrides);
  const quality = useUiStore((s) => s.quality);
  const tier = useQualityTier();
  const profile = QUALITY_PROFILES[tier];
  const count = overrideCount(overrides);
  // One cast so the generic store action can be driven from the untyped table.
  const apply = setRenderOverride as (
    key: OverrideKey,
    value: number | boolean | undefined,
  ) => void;

  return (
    <details className="text-[11px] text-surface-300">
      <summary className="heading cursor-pointer rounded py-1 focus-visible:outline-2 focus-visible:outline-accent-400">
        Tweaks{count > 0 && <span className="font-normal"> · {count} active</span>}
      </summary>
      <div className="glass-scroll mt-2 flex max-h-72 flex-col gap-2 overflow-y-auto pr-1">
        {quality === "auto" && count > 0 && (
          <p className="text-warn">
            Auto may still change the tier under you — fix a tier for a clean A/B.
          </p>
        )}
        <RenderScale overrides={overrides} tierPixels={profile.maxPixels} apply={apply} />
        {TWEAK_CONTROLS.map((control) => (
          <Row
            key={control.key}
            control={control}
            current={overrides[control.key]}
            tierLabel={tierValueLabel(control, profile)}
            apply={apply}
          />
        ))}
        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="text-surface-500">
            WebGL2 ignores point/vehicle light counts and caps AO at 8 samples.
          </span>
          <Button
            variant="ghost"
            size="xs"
            disabled={count === 0}
            onClick={resetRenderOverrides}
            className="shrink-0"
          >
            Reset tweaks
          </Button>
        </div>
      </div>
    </details>
  );
}

function Row({
  control,
  current,
  tierLabel,
  apply,
}: {
  control: TweakControl;
  current: number | boolean | undefined;
  tierLabel: string;
  apply: (key: OverrideKey, value: number | boolean | undefined) => void;
}) {
  const options = [
    { value: "tier", label: "tier" },
    ...control.choices.map((c) => ({ value: choiceId(c.value), label: c.label })),
  ];
  const selected = current === undefined ? "tier" : choiceId(current);
  return (
    <div className="flex flex-col gap-1">
      <span>
        {control.label} <span className="text-surface-500">· tier {tierLabel}</span>
      </span>
      <SegmentedControl
        options={options}
        value={selected}
        onChange={(id) => {
          const choice = control.choices.find((c) => choiceId(c.value) === id);
          apply(control.key, choice?.value);
        }}
      />
    </div>
  );
}

/** Committed on release only: changing it resizes every render target. */
function RenderScale({
  overrides,
  tierPixels,
  apply,
}: {
  overrides: QualityOverrides;
  tierPixels: number;
  apply: (key: OverrideKey, value: number | boolean | undefined) => void;
}) {
  const override = overrides.maxPixels;
  const effective = override ?? tierPixels;
  const [draft, setDraft] = useState(() => effective / 1e6);
  useEffect(() => {
    setDraft(effective / 1e6);
  }, [effective]);
  const commit = () => apply("maxPixels", Math.round(draft * 1e6));
  const fill = ((draft - MIN_MPX) / (MAX_MPX - MIN_MPX)) * 100;
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-1">
        Render scale cap
        <span className="text-white">{draft.toFixed(1)} Mpx</span>
        <span className="text-surface-500">· tier {(tierPixels / 1e6).toFixed(1)}</span>
        <Button
          variant="ghost"
          size="xs"
          className="ml-auto"
          disabled={override === undefined}
          onClick={() => apply("maxPixels", undefined)}
        >
          tier
        </Button>
      </span>
      <input
        type="range"
        className="slider-input w-full"
        style={{ "--slider-fill": `${fill}%` } as CSSProperties}
        min={MIN_MPX}
        max={MAX_MPX}
        step={0.1}
        value={draft}
        aria-label="Render scale cap in megapixels"
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
    </div>
  );
}
