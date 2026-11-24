import { describe, expect, test } from "bun:test";
import type { LogQuery, LogTarget } from "../../proxy/providers/logsources/types.ts";
import {
  schemaFromEnv,
  VictoriaLogsSource,
} from "../../proxy/providers/logsources/victorialogs.ts";

const targets: LogTarget[] = [
  {
    address: "quartz/apps_api",
    cityId: "quartz",
    nodeId: "apps_api",
    serviceId: "svc1",
    swarmNodeId: "n1",
  },
  {
    address: "basalt/apps_api",
    cityId: "basalt",
    nodeId: "apps_api",
    serviceId: "svc1",
    swarmNodeId: "n2",
  },
];
const q: LogQuery = { targets, since: 0, until: 1, limit: 10 };
const line = (o: Record<string, string>) => JSON.stringify(o);

describe("VictoriaLogs schemas", () => {
  test("vector filters Swarm ids with a field scan", () => {
    const src = new VictoriaLogsSource(schemaFromEnv({}));
    expect(src.buildQuery(q)).toStartWith('"label.com.docker.swarm.service.id":in("svc1")');
  });

  test("promtail filters service names as a stream", () => {
    const src = new VictoriaLogsSource(schemaFromEnv({ VICTORIALOGS_SCHEMA: "promtail" }));
    expect(src.buildQuery(q)).toStartWith('{swarm_service in("apps_api")}');
  });

  test("promtail attributes each line to its emitting node, oldest first", () => {
    const src = new VictoriaLogsSource(schemaFromEnv({ VICTORIALOGS_SCHEMA: "promtail" }));
    const body = [
      line({
        _time: "2026-11-24T15:20:14Z",
        _msg: "b",
        swarm_service: "apps_api",
        swarm_instance: "basalt",
      }),
      line({
        _time: "2026-11-24T15:20:13Z",
        _msg: "a",
        swarm_service: "apps_api",
        swarm_instance: "quartz",
      }),
      line({
        _time: "2026-11-24T15:20:15Z",
        _msg: "x",
        swarm_service: "other",
        swarm_instance: "quartz",
      }),
    ].join("\n");
    expect(src.parse(body, targets).map((e) => [e.node, e.message])).toEqual([
      ["quartz/apps_api", "a"],
      ["basalt/apps_api", "b"],
    ]);
  });

  test("field names can be overridden", () => {
    const s = schemaFromEnv({ VICTORIALOGS_SCHEMA: "promtail", VICTORIALOGS_NODE_FIELD: "host" });
    expect(s).toMatchObject({ serviceField: "swarm_service", nodeField: "host", keys: "name" });
  });
});
