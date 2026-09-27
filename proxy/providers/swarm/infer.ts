// Pure topology inference: Swarm API objects → TopologyEntries → NodeMeta.

import type { NodeMeta } from "../../protocol.ts";
import { bytesToMb, nanoToCores } from "../units.ts";
import type { SwarmService, SwarmTask, TopologyEntry } from "./types.ts";

/** Infer a Conf City node type from Docker image name and labels. */
export function inferNodeType(image: string, labels: Record<string, string>): string {
  if (labels["confcity.type"]) {
    return labels["confcity.type"];
  }

  const img = image.toLowerCase();
  if (
    /postgres|mysql|mariadb|mongo|clickhouse|cockroach|cassandra|couchdb|influx|timescale/.test(img)
  ) {
    return "db";
  }
  if (/redis|memcache|varnish|hazelcast/.test(img)) {
    return "cache";
  }
  if (/rabbit|kafka|nats|pulsar|activemq|celery|bull/.test(img)) {
    return "queue";
  }
  return "app";
}

export function parseList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(/[,\s]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

export function parseBool(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

/** Guess dependencies from env values that mention another service name (host part of URLs, HOST vars…). */
export function inferLinksFromEnv(
  env: string[] | undefined,
  serviceNames: Set<string>,
  self: string,
): string[] {
  if (!env || env.length === 0) {
    return [];
  }
  const found = new Set<string>();
  for (const kv of env) {
    const eq = kv.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const value = kv.slice(eq + 1);
    const tokens = value.split(/[^A-Za-z0-9_.-]+/);
    for (const raw of tokens) {
      const token = raw.replace(/\.$/, "");
      if (token && token !== self && serviceNames.has(token)) {
        found.add(token);
      }
    }
  }
  return [...found];
}

/** Group running Swarm tasks into TopologyEntries keyed by (node, service). */
export function groupTasksIntoTopology(
  tasks: SwarmTask[],
  hostnameOf: Map<string, string>,
  serviceOf: Map<string, SwarmService>,
): TopologyEntry[] {
  const skipStates = new Set(["complete", "orphaned", "remove"]);
  const groups = new Map<string, TopologyEntry>();
  const serviceNames = new Set([...serviceOf.values()].map((s) => s.Spec.Name));

  for (const task of tasks) {
    if (!task.NodeID || skipStates.has(task.Status.State)) {
      continue;
    }

    const hostname = hostnameOf.get(task.NodeID);
    const svc = serviceOf.get(task.ServiceID);
    if (!hostname || !svc) {
      continue;
    }

    const key = `${task.NodeID}::${task.ServiceID}`;

    if (!groups.has(key)) {
      const image = svc.Spec.TaskTemplate.ContainerSpec.Image;
      const labels = { ...svc.Spec.Labels, ...svc.Spec.TaskTemplate.ContainerSpec.Labels };
      const res = svc.Spec.TaskTemplate.Resources;
      const nanoCpus = res?.Limits?.NanoCPUs || res?.Reservations?.NanoCPUs;
      const memBytes = res?.Limits?.MemoryBytes || res?.Reservations?.MemoryBytes;
      const linkServices = parseList(labels["confcity.links"]);
      // The label's mere presence takes control: `confcity.links=` (empty) means
      // "this service has no outgoing links", not "please guess them".
      const explicitLinks = labels["confcity.links"] !== undefined;
      groups.set(key, {
        cityId: hostname,
        nodeId: svc.Spec.Name,
        type: inferNodeType(image, labels),
        label: labels["confcity.label"] ?? svc.Spec.Name,
        description: labels["confcity.description"],
        group: labels["confcity.group"],
        hidden: parseBool(labels["confcity.hidden"]),
        ingress: parseBool(labels["confcity.ingress"]),
        ambient: parseBool(labels["confcity.ambient"]),
        linkServices,
        explicitLinks,
        inferredLinkServices: explicitLinks
          ? []
          : inferLinksFromEnv(svc.Spec.TaskTemplate.ContainerSpec.Env, serviceNames, svc.Spec.Name),
        cpuLimit: nanoCpus ? nanoToCores(nanoCpus) : undefined,
        memLimitMb: memBytes ? Math.round(bytesToMb(memBytes)) : undefined,
        serviceId: svc.ID,
        swarmNodeId: task.NodeID,
        containerIds: [],
        taskStates: [],
      });
    }

    const g = groups.get(key)!;
    g.taskStates.push(task.Status.State);
    const cid = task.Status.ContainerStatus?.ContainerID;
    if (cid) {
      g.containerIds.push(cid);
    }
  }

  return Array.from(groups.values());
}

/**
 * A target that a large share of services point to *by inference* is almost always
 * ambient infrastructure — auth, log store, metrics — whose URL sits in everyone's
 * environment. Drawing a road from every building to it buries the real topology
 * under a star, so inferred links to such hubs are dropped. Explicit
 * `confcity.links` are never filtered: declare the link to keep it.
 */
const HUB_MIN_SOURCES = 3;
const HUB_SOURCE_RATIO = 0.4;

/** Hub and ambient sets last logged (sorted, comma-joined), so each change is logged once. */
export interface MetaLogState {
  hubs: string;
  ambient: string;
}

export function findInferredHubs(topo: TopologyEntry[], logged: MetaLogState): Set<string> {
  const services = new Set<string>();
  const sourcesOf = new Map<string, Set<string>>();
  for (const e of topo) {
    if (e.hidden) {
      continue;
    }
    services.add(e.nodeId);
    if (e.explicitLinks) {
      continue;
    }
    for (const target of e.inferredLinkServices) {
      if (target === e.nodeId) {
        continue;
      }
      let sources = sourcesOf.get(target);
      if (!sources) {
        sources = new Set();
        sourcesOf.set(target, sources);
      }
      sources.add(e.nodeId);
    }
  }

  const hubs = new Set<string>();
  for (const [target, sources] of sourcesOf) {
    if (sources.size >= HUB_MIN_SOURCES && sources.size >= (services.size - 1) * HUB_SOURCE_RATIO) {
      hubs.add(target);
    }
  }

  const key = [...hubs].sort().join(",");
  if (key !== logged.hubs) {
    logged.hubs = key;
    if (hubs.size > 0) {
      console.log(`[swarm] Inferred-link hubs treated as ambient infrastructure: ${key}`);
    }
  }
  return hubs;
}

/**
 * Resolve `confcity.links` service names to full addresses (a service may run on several nodes).
 * `ambientFromEnv` adds to the services labelled `confcity.ambient`.
 */
export function buildMetaBatch(
  topo: TopologyEntry[],
  ambientFromEnv: Set<string>,
  logged: MetaLogState,
): Record<string, NodeMeta> {
  const addressesOfService = new Map<string, string[]>();
  for (const e of topo) {
    if (e.hidden) {
      continue;
    }
    const list = addressesOfService.get(e.nodeId) ?? [];
    list.push(`${e.cityId}/${e.nodeId}`);
    addressesOfService.set(e.nodeId, list);
  }
  const resolve = (names: string[], from: string) => {
    const out: string[] = [];
    for (const name of names) {
      const targets = addressesOfService.get(name);
      if (!targets) {
        console.warn(`[swarm] ${from}: confcity.links references unknown service "${name}"`);
        continue;
      }
      // Prefer the replica on the same node when one exists, otherwise link to every node running it.
      const sameCity = targets.filter((a) => a.startsWith(`${from.split("/")[0]}/`));
      out.push(...(sameCity.length > 0 ? sameCity : targets));
    }
    return [...new Set(out)];
  };

  const hubs = findInferredHubs(topo, logged);

  // Ambient infrastructure — auth, log store… — keeps its building but attracts
  // no road, even declared ones: everyone talks to it, drawing it teaches nothing.
  const ambient = new Set(ambientFromEnv);
  for (const e of topo) {
    if (e.ambient) {
      ambient.add(e.nodeId);
    }
  }
  const ambientKey = [...ambient].sort().join(",");
  if (ambientKey !== logged.ambient) {
    logged.ambient = ambientKey;
    if (ambient.size > 0) {
      console.log(`[swarm] Ambient services (links to them dropped): ${ambientKey}`);
    }
  }

  const batch: Record<string, NodeMeta> = {};
  for (const e of topo) {
    const addr = `${e.cityId}/${e.nodeId}`;
    const names = (
      e.explicitLinks ? e.linkServices : e.inferredLinkServices.filter((n) => !hubs.has(n))
    ).filter((n) => !ambient.has(n));
    const links = resolve(names, addr).filter((a) => a !== addr);
    batch[addr] = {
      type: e.type,
      label: e.label,
      description: e.description,
      group: e.group,
      hidden: e.hidden || undefined,
      ingress: e.ingress || undefined,
      links: links.length > 0 ? links : undefined,
      linksInferred: !e.explicitLinks && links.length > 0 ? true : undefined,
    };
  }
  return batch;
}
