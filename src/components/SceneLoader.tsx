import { Html } from "@react-three/drei";
import { useHtmlPortal } from "./htmlPortal";

/** Suspense fallback while the city models load. */
export function SceneLoader() {
  const portal = useHtmlPortal();
  return (
    <Html center portal={portal}>
      <div className="glass-morphic rounded-xl px-4 py-2 text-[12px] text-white">
        Loading models…
      </div>
    </Html>
  );
}
