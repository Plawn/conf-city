import { describe, expect, test } from "bun:test";
import {
  assemble,
  buildQueries,
  configFromEnv,
  type Sample,
} from "../../proxy/providers/victoria/metrics.ts";

const cfg = configFromEnv({});
const s = (metric: Record<string, string>, v: string, t = 1_700_000_000): Sample => ({
  metric,
  value: [t, v],
});

describe("buildQueries", () => {
  test("aggregates services to (host, service) and machines to instance", () => {
    const q = buildQueries(cfg);
    expect(q.service.cpu).toContain("sum by (engine_host, com_docker_swarm_service_name)");
    expect(q.service.cpu).toContain('cpu="cpu-total"');
    expect(q.machine.cpuUsedCores).toContain('mode!~"idle|iowait"');
    expect(q.machine.diskTotalMb).toContain('mountpoint="/"');
  });

  test("honours custom labels and filters", () => {
    const q = buildQueries(
      configFromEnv({ VM_HOST_LABEL: "host", VM_CONTAINER_FILTER: "", VM_RATE_WINDOW: "1m" }),
    );
    expect(q.service.netRxKbps).toContain("by (host, com_docker_swarm_service_name)");
    expect(q.service.netRxKbps).toContain('{com_docker_swarm_service_name!=""}[1m]');
  });
});

describe("assemble", () => {
  test("maps series to addresses and cities, rounding like the agent", () => {
    const svc = { engine_host: "basalt", com_docker_swarm_service_name: "apps_api" };
    const { nodes, cities } = assemble(
      cfg,
      { cpu: [s(svc, "12.345")], memoryMb: [s(svc, "511.6")], netRxKbps: [s(svc, "NaN")] },
      {
        load1: [s({ instance: "basalt" }, "0.734", 100)],
        memUsedMb: [s({ instance: "basalt" }, "9402.2", 101)],
      },
    );
    expect(nodes).toEqual({ "basalt/apps_api": { cpu: 12.3, memoryMb: 512 } });
    expect(cities).toEqual({ basalt: { load1: 0.73, memUsedMb: 9402, at: 101_000 } });
  });

  test("skips series missing an address label", () => {
    const { nodes, cities } = assemble(
      cfg,
      { cpu: [s({ engine_host: "basalt" }, "1")] },
      { load1: [s({}, "1")] },
    );
    expect(nodes).toEqual({});
    expect(cities).toEqual({});
  });
});
