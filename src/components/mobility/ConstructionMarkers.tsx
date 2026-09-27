import { useMobilityStore } from "../../store/mobilityStore";
import { SceneLabel } from "../SceneLabel";
export function ConstructionMarkers({ visibleCities }: { visibleCities: Set<string> }) {
  const jobs = useMobilityStore((s) => s.construction);
  return (
    <group>
      {jobs
        .filter(
          (job) =>
            job.position &&
            (job.key.startsWith("city:")
              ? visibleCities.has(job.key.slice(5))
              : job.accessCities?.every((id) => visibleCities.has(id))),
        )
        .map((job) => (
          <group key={job.key} position={job.position}>
            <mesh position={[0, 0.3, 0]}>
              <coneGeometry args={[0.2, 0.6, 4]} />
              <meshStandardMaterial color="#ffc46b" />
            </mesh>
            <SceneLabel position={[0, 2.5, 0]}>
              <span className="whitespace-nowrap rounded-lg border border-amber-200/40 bg-amber-950/90 px-3 py-1 text-[12px] text-amber-100">
                🏗{" "}
                {job.kind === "bridge"
                  ? "Double deck + wider accesses"
                  : job.kind === "roads"
                    ? "Wider roads"
                    : "Metro"}{" "}
                · {Math.ceil(job.remaining)}s
              </span>
            </SceneLabel>
          </group>
        ))}
    </group>
  );
}
