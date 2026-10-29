// Scenario skeleton from today's infrastructure: every city and service, there from `start`.
// Usage: bun scripts/scenario-from-snapshot.ts [snapshot.json | ws://host:4001/ws/frontend]
//   [--out public/scenarios/my-year.json] [--title "Infra Wrapped 2026"] [--year 2026]
import type { SnapshotMessage } from "../proxy/protocol";
import { scenarioFromSnapshot } from "../src/domain/scenario";

const argv = process.argv.slice(2);
const flags = new Map<string, string>();
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!;
  if (arg.startsWith("--")) {
    flags.set(arg.slice(2), argv[++i] ?? "");
  } else {
    positional.push(arg);
  }
}
const source = positional[0] ?? process.env.PROXY_URL ?? "ws://localhost:4001/ws/frontend";
const year = flags.get("year") ?? String(new Date().getFullYear());
const out = flags.get("out") ?? `public/scenarios/${year}.json`;

const snapshot = /^wss?:/.test(source)
  ? await fromProxy(source)
  : ((await Bun.file(source).json()) as SnapshotMessage);
const scenario = scenarioFromSnapshot(snapshot, {
  title: flags.get("title") ?? `Infra Wrapped ${year}`,
  start: `${year}-01-01`,
  end: `${year}-12-31`,
});
await Bun.write(out, `${JSON.stringify(scenario, null, 2)}\n`);
const services = scenario.cities.reduce((sum, c) => sum + c.nodes.length, 0);
console.log(`${scenario.cities.length} cities, ${services} services → ${out}`);
console.log(
  `Date each piece with \`since\` / \`until\`, then open ?replay=/${out.replace(/^public\//, "")}`,
);

/** The proxy greets each frontend with a full snapshot. */
function fromProxy(url: string): Promise<SnapshotMessage> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`${url}: no snapshot within 10 s`));
    }, 10_000);
    socket.onerror = () => reject(new Error(`${url}: connection failed`));
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { type: string };
      if (message.type === "snapshot") {
        clearTimeout(timer);
        socket.close();
        resolve(message as SnapshotMessage);
      }
    };
  });
}
