import { createContext, type RefObject, useContext } from "react";

/**
 * DOM layer that receives every drei `<Html>` (labels, tooltips).
 * Rendered by WorldScene below the glass panels (z-10) so 3D labels never cover the UI.
 */
export const HtmlPortalContext = createContext<RefObject<HTMLDivElement | null> | null>(null);

export function useHtmlPortal() {
  const ref = useContext(HtmlPortalContext);
  // drei's `portal` prop expects a non-null ref object; undefined falls back to the canvas parent.
  return (ref?.current ? ref : undefined) as RefObject<HTMLElement> | undefined;
}
