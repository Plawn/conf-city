import type { Node, NodeFrame } from "three/webgpu";

/** Keep a pass and its texture bindings alive, updating black output once on suspension. */
export function gatePass(
  node: Pick<Node, "updateBefore">,
  active: () => boolean,
  onUpdate: () => void,
  clear?: (frame: NodeFrame) => void,
) {
  const update = node.updateBefore.bind(node);
  let black = false;
  node.updateBefore = (frame) => {
    if (active()) {
      black = false;
      onUpdate();
      return update(frame);
    }
    if (!black) {
      // For the volume, clear explicitly. For its blur, run once over that black input.
      // Setting black only after success also allows retry after a failed render.
      if (clear) {
        clear(frame);
      } else {
        onUpdate();
        update(frame);
      }
      black = true;
    }
    return undefined;
  };
}
