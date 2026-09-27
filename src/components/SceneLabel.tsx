import { Html } from "@react-three/drei";
import type { ComponentProps } from "react";
import { useHtmlPortal } from "./htmlPortal";

const PASS_THROUGH = { pointerEvents: "none" } as const;

/** A centred, click-through drei `<Html>` in the shared label overlay; extra props go to `<Html>`. */
export function SceneLabel({ children, ...props }: ComponentProps<typeof Html>) {
  const portal = useHtmlPortal();
  return (
    <Html center portal={portal} style={PASS_THROUGH} {...props}>
      {children}
    </Html>
  );
}
