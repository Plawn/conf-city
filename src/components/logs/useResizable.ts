import { useCallback, useRef, useState } from "react";

const MIN_W = 320;
const MIN_H = 200;
const DEFAULT_W = 560;
const DEFAULT_H = 400;

/** Panel size, dragged from its top-left corner (it is anchored bottom-right), clamped to the window. */
export function useResizable() {
  const [panelSize, setPanelSize] = useState({ width: DEFAULT_W, height: DEFAULT_H });
  const dragRef = useRef<{ startX: number; startY: number; startW: number; startH: number } | null>(
    null,
  );
  const handleResizeDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        startW: panelSize.width,
        startH: panelSize.height,
      };
      const onMove = (ev: MouseEvent) => {
        if (!dragRef.current) {
          return;
        }
        const dw = dragRef.current.startX - ev.clientX;
        const dh = dragRef.current.startY - ev.clientY;
        setPanelSize({
          width: Math.max(MIN_W, Math.min(window.innerWidth * 0.9, dragRef.current.startW + dw)),
          height: Math.max(MIN_H, Math.min(window.innerHeight * 0.8, dragRef.current.startH + dh)),
        });
      };
      const onUp = () => {
        dragRef.current = null;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [panelSize],
  );
  return { panelSize, handleResizeDown };
}
