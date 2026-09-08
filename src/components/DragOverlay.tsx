export function DragOverlay({ active }: { active: boolean }) {
  if (!active) {
    return null;
  }
  return (
    <div className="pointer-events-none absolute inset-0 z-[90] flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="glass-morphic-thick rounded-3xl border-2 border-dashed !border-accent-300/60 px-12 py-10 text-center">
        <div className="text-lg font-semibold">Drop JSON to load a world</div>
        <div className="mt-1 text-[12px] text-surface-300">
          Expected shape: {"{ cities: [{ id, nodes }] }"}
        </div>
      </div>
    </div>
  );
}
