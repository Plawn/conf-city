import { forwardRef } from "react";
import { NODE_STYLE } from "../../domain/nodeStyle";
import type { PositionedNode } from "../../domain/types";
import { Input } from "../ui";

export const SearchPanel = forwardRef<
  HTMLInputElement,
  {
    value: string;
    onChange: (v: string) => void;
    results: PositionedNode[];
    onPick: (node: PositionedNode) => void;
  }
>(function SearchPanel({ value, onChange, results, onPick }, ref) {
  return (
    <div>
      <div className="heading mb-2 flex items-center justify-between">
        <span>Search</span>
        <kbd className="rounded border border-white/15 bg-white/5 px-1 font-mono text-[9px] text-surface-400">
          /
        </kbd>
      </div>
      <Input
        ref={ref}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && results[0]) {
            onPick(results[0]);
          }
        }}
        placeholder="Find a node..."
      />
      {results.length > 0 && (
        <div className="glass-scroll mt-1 max-h-40 overflow-y-auto">
          {results.map((node) => (
            <button
              key={`${node.cityId}-${node.id}`}
              type="button"
              onClick={() => onPick(node)}
              className="flex w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] hover:bg-white/10"
            >
              <span
                className="h-2 w-2 shrink-0 rounded-sm"
                style={{ background: NODE_STYLE[node.type].color }}
              />
              <span className="truncate">{node.label}</span>
              <span className="ml-auto shrink-0 text-[11px] text-surface-500">{node.cityId}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
});
