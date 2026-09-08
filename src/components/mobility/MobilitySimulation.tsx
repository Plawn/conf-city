import { useFrame } from "@react-three/fiber";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef } from "react";
import { createMobilityEngine, type MobilityParticipant } from "./engine";

const Context = createContext<ReturnType<typeof createMobilityEngine> | null>(null);

export function MobilitySimulation({ children }: { children: ReactNode }) {
  const engine = useMemo(createMobilityEngine, []);
  useEffect(() => {
    const pause = () => engine.pause();
    document.addEventListener("visibilitychange", pause);
    return () => document.removeEventListener("visibilitychange", pause);
  }, [engine]);
  useFrame((_, delta) => engine.advance(delta));
  return <Context.Provider value={engine}>{children}</Context.Provider>;
}

export function useMobilityParticipant(
  step: MobilityParticipant["step"],
  render: MobilityParticipant["render"],
) {
  const engine = useContext(Context);
  if (!engine) {
    throw new Error("Transport must be inside MobilitySimulation");
  }
  const callbacks = useRef({ step, render });
  callbacks.current = { step, render };
  useEffect(
    () =>
      engine.register({
        step: (dt) => callbacks.current.step(dt),
        render: () => callbacks.current.render(),
      }),
    [engine],
  );
}
