import { LINK_COLORS, LIVENESS_COLORS, NODE_STYLE } from "../../domain/nodeStyle";
import type { LivenessStatus, NodeType } from "../../domain/types";

export function LegendPanel() {
  return (
    <div>
      <div className="heading mb-2">Legend</div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        {(Object.keys(NODE_STYLE) as NodeType[]).map((type) => (
          <div key={type} className="flex items-center gap-2 text-[12px] capitalize">
            <span
              className="h-3 w-3 shrink-0 rounded-sm"
              style={{ background: NODE_STYLE[type].color }}
            />
            {type}
          </div>
        ))}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-white/10 pt-2">
        {(Object.keys(LIVENESS_COLORS) as LivenessStatus[]).map((l) => (
          <div key={l} className="flex items-center gap-2 text-[11px] capitalize text-surface-300">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: LIVENESS_COLORS[l], boxShadow: `0 0 6px ${LIVENESS_COLORS[l]}` }}
            />
            {l}
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-col gap-1 border-t border-white/10 pt-2 text-[11px] text-surface-300">
        <div className="flex items-center gap-2">
          <span className="h-0.5 w-3 shrink-0" style={{ background: LINK_COLORS.intra }} />
          Intra-city link
        </div>
        <div className="flex items-center gap-2">
          <span className="h-0.5 w-3 shrink-0" style={{ background: LINK_COLORS.inter }} />
          Inter-city link
        </div>
      </div>
      <div className="mt-2 flex flex-col gap-1 border-t border-white/10 pt-2 text-[11px] text-surface-300">
        <div className="flex items-start gap-2">
          <span aria-hidden="true">🔥</span>
          <span>Fire = unavailable, degraded or &gt;1% errors. Larger fire = unavailable.</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-3 text-center text-surface-500">▲</span>Height = memory
        </div>
        <div className="flex items-center gap-2">
          <span className="w-3 text-center text-warn">✦</span>Glow = CPU saturation
        </div>
        <div className="flex items-center gap-2">
          <span className="w-3 text-center" style={{ color: "#3ddc84" }}>
            ◯
          </span>
          Ring = memory vs limit
        </div>
        <div className="flex items-center gap-2">
          <span className="w-3 text-center text-surface-500">⇢</span>Dash speed = network out
        </div>
        <div className="flex items-center gap-2">
          <span className="w-3 text-center text-surface-500">▣</span>City badge = machine (CPU · mem
          · disk)
        </div>
        <div className="flex items-start gap-2">
          <span className="w-3 text-center" style={{ color: "#ffb020" }}>
            ☀
          </span>
          <span>
            Lighthouse = worst of the machine's CPU / mem / disk. Faster sweep = worse; blinking =
            services estimate.
          </span>
        </div>
        <div className="flex items-start gap-2">
          <span className="w-3 text-center text-surface-500">☁</span>
          <span>Power station = CPU: more smoke, faster and hotter, the harder it works.</span>
        </div>
        <div className="flex items-start gap-2">
          <span className="w-3 text-center text-surface-500">◍</span>
          <span>Water tower = memory: the tank fills up, empty at 0 % and full at 100 %.</span>
        </div>
        <div className="flex items-start gap-2">
          <span className="w-3 text-center text-surface-500">▤</span>
          <span>
            Container quay = disk: boxes stack up, and one spills over past 95 %. Scaffolding = not
            measured on the machine.
          </span>
        </div>
      </div>
    </div>
  );
}
