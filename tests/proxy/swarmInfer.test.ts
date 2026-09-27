import { describe, expect, test } from "bun:test";
import {
  groupTasksIntoTopology,
  inferLinksFromEnv,
  inferNodeType,
  parseBool,
  parseList,
} from "../../proxy/providers/swarm/infer";
import type { SwarmService, SwarmTask } from "../../proxy/providers/swarm/types";

const MiB = 1024 * 1024;

function service(
  id: string,
  name: string,
  image: string,
  opts: {
    labels?: Record<string, string>;
    containerLabels?: Record<string, string>;
    env?: string[];
    resources?: SwarmService["Spec"]["TaskTemplate"]["Resources"];
  } = {},
): SwarmService {
  return {
    ID: id,
    Spec: {
      Name: name,
      Labels: opts.labels ?? {},
      TaskTemplate: {
        ContainerSpec: { Image: image, Labels: opts.containerLabels, Env: opts.env },
        Resources: opts.resources,
      },
    },
  };
}

function task(
  id: string,
  serviceId: string,
  nodeId: string,
  state: string,
  cid?: string,
): SwarmTask {
  return {
    ID: id,
    ServiceID: serviceId,
    NodeID: nodeId,
    Status: {
      State: state,
      Timestamp: "2026-01-01T00:00:00Z",
      ContainerStatus: cid ? { ContainerID: cid } : undefined,
    },
    DesiredState: "running",
  };
}

describe("inferNodeType", () => {
  test("the confcity.type label wins over the image", () => {
    expect(inferNodeType("postgres:16", { "confcity.type": "queue" })).toBe("queue");
  });

  test("image names map to db, cache, queue, else app", () => {
    expect(inferNodeType("mysql:8", {})).toBe("db");
    expect(inferNodeType("ghcr.io/org/timescale-ha", {})).toBe("db");
    expect(inferNodeType("bitnami/redis:7", {})).toBe("cache");
    expect(inferNodeType("RabbitMQ:3-management", {})).toBe("queue");
    expect(inferNodeType("nginx:alpine", {})).toBe("app");
  });
});

describe("parseList / parseBool", () => {
  test("parseList splits on commas and whitespace, dropping empties", () => {
    expect(parseList("a, b  c,,d")).toEqual(["a", "b", "c", "d"]);
    expect(parseList("")).toEqual([]);
    expect(parseList(undefined)).toEqual([]);
  });

  test("parseBool accepts 1/true/yes/on, case-insensitively", () => {
    for (const v of ["1", "true", "TRUE", "Yes", "on"]) {
      expect(parseBool(v)).toBe(true);
    }
    for (const v of ["0", "false", "no", "y", "", undefined]) {
      expect(parseBool(v)).toBe(false);
    }
  });
});

describe("inferLinksFromEnv", () => {
  const names = new Set(["web", "db", "cache", "worker"]);

  test("finds service names in env values, once each, never itself", () => {
    const env = [
      "DATABASE_URL=postgres://db:5432/app",
      "REDIS_HOST=cache.",
      "SELF=web",
      "BACKUP=postgres://db/other",
      "OTHER=dbx",
      "NOEQUALS",
    ];
    expect(inferLinksFromEnv(env, names, "web")).toEqual(["db", "cache"]);
  });

  test("ignores variable names and handles missing env", () => {
    expect(inferLinksFromEnv(["db=1"], names, "web")).toEqual([]);
    expect(inferLinksFromEnv(undefined, names, "web")).toEqual([]);
    expect(inferLinksFromEnv([], names, "web")).toEqual([]);
  });
});

describe("groupTasksIntoTopology", () => {
  const services = [
    service("s-web", "web", "myorg/web:1", {
      labels: { "confcity.label": "Web", "confcity.ingress": "true" },
      containerLabels: { "confcity.label": "Web front", "confcity.group": "front" },
      env: ["DATABASE_URL=postgres://db:5432/app", "REDIS_HOST=cache"],
    }),
    service("s-db", "db", "postgres:16", {
      resources: { Limits: { NanoCPUs: 1_500_000_000, MemoryBytes: 512 * MiB } },
    }),
    service("s-cache", "cache", "redis:7"),
    service("s-worker", "worker", "myorg/worker", {
      labels: { "confcity.type": "queue", "confcity.links": "db, cache", "confcity.hidden": "yes" },
      env: ["UPSTREAM=http://web"],
      resources: { Reservations: { NanoCPUs: 250_000_000, MemoryBytes: 100 * MiB } },
    }),
  ];
  const serviceOf = new Map(services.map((s) => [s.ID, s]));
  const hostnameOf = new Map([
    ["n1", "host-a"],
    ["n2", "host-b"],
  ]);
  const tasks = [
    task("t1", "s-web", "n1", "running", "c1"),
    task("t2", "s-web", "n1", "running", "c2"),
    task("t3", "s-web", "n2", "failed"),
    task("t4", "s-db", "n1", "complete", "c4"),
    task("t5", "s-db", "n2", "running", "c5"),
    task("t6", "s-cache", "n9", "running", "c6"),
    task("t7", "s-cache", "", "pending"),
    task("t8", "s-gone", "n1", "running", "c8"),
    task("t9", "s-worker", "n1", "running", "c9"),
  ];
  const topo = groupTasksIntoTopology(tasks, hostnameOf, serviceOf);

  test("one entry per (node, service), skipping finished, unplaced and unknown tasks", () => {
    expect(topo.map((e) => `${e.cityId}/${e.nodeId}`)).toEqual([
      "host-a/web",
      "host-b/web",
      "host-b/db",
      "host-a/worker",
    ]);
  });

  test("replicas on the same node are merged", () => {
    const web = topo[0]!;
    expect(web.taskStates).toEqual(["running", "running"]);
    expect(web.containerIds).toEqual(["c1", "c2"]);
    expect(topo[1]!.taskStates).toEqual(["failed"]);
    expect(topo[1]!.containerIds).toEqual([]);
  });

  test("container labels override service labels; links are inferred from env", () => {
    expect(topo[0]).toMatchObject({
      type: "app",
      label: "Web front",
      group: "front",
      hidden: false,
      ingress: true,
      ambient: false,
      linkServices: [],
      explicitLinks: false,
      inferredLinkServices: ["db", "cache"],
      cpuLimit: undefined,
      memLimitMb: undefined,
      serviceId: "s-web",
      swarmNodeId: "n1",
    });
  });

  test("limits come from Limits, falling back to Reservations", () => {
    expect(topo[2]).toMatchObject({ type: "db", label: "db", cpuLimit: 1.5, memLimitMb: 512 });
    expect(topo[3]).toMatchObject({ cpuLimit: 0.25, memLimitMb: 100 });
  });

  test("an explicit confcity.links disables env inference", () => {
    expect(topo[3]).toMatchObject({
      type: "queue",
      hidden: true,
      linkServices: ["db", "cache"],
      explicitLinks: true,
      inferredLinkServices: [],
    });
  });

  test("an empty confcity.links still counts as explicit", () => {
    const svc = service("s-x", "x", "myorg/x", {
      labels: { "confcity.links": "" },
      env: ["DB=db"],
    });
    const [entry] = groupTasksIntoTopology(
      [task("t", "s-x", "n1", "running", "cx")],
      hostnameOf,
      new Map([
        ["s-x", svc],
        ["s-db", services[1]!],
      ]),
    );
    expect(entry).toMatchObject({
      linkServices: [],
      explicitLinks: true,
      inferredLinkServices: [],
    });
  });
});
