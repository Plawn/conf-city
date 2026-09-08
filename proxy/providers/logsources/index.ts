import type { DockerClient } from "../docker-api.ts";
import { DockerLogSource } from "./docker.ts";
import type { LogSource } from "./types.ts";
import { VictoriaLogsSource } from "./victorialogs.ts";

export { getLogLevel } from "./level.ts";
export type { LogQuery, LogSource, LogTarget } from "./types.ts";

/**
 * Pick the log backend from `LOGS_BACKEND`. Exactly one is ever active: two sources reading
 * the same containers would push every line twice, under slightly different timestamps that
 * no deduplication can reconcile.
 *
 * Defaults to "docker" so an existing deployment keeps behaving as it did.
 */
export function makeLogSource(docker: DockerClient): LogSource {
  const backend = process.env.LOGS_BACKEND ?? "docker";
  switch (backend) {
    case "victorialogs":
      return new VictoriaLogsSource();
    case "docker":
      return new DockerLogSource(docker);
    default:
      console.warn(`[logs] Unknown LOGS_BACKEND "${backend}", falling back to docker`);
      return new DockerLogSource(docker);
  }
}
