import { ConnectionManager, type WSData } from "./connections.ts";
import type { FrontendMessage, ProviderMessage } from "./protocol.ts";
import { TelemetryStore } from "./state.ts";

const PORT = Number(process.env.PROXY_PORT) || 4001;

const store = new TelemetryStore();
const conns = new ConnectionManager(store);

const server = Bun.serve<WSData>({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade
    if (url.pathname === "/ws/provider") {
      const id = conns.assignId();
      const ok = server.upgrade(req, { data: { role: "provider", id } });
      return ok ? undefined : new Response("Upgrade failed", { status: 500 });
    }
    if (url.pathname === "/ws/frontend") {
      const id = conns.assignId();
      const ok = server.upgrade(req, { data: { role: "frontend", id } });
      return ok ? undefined : new Response("Upgrade failed", { status: 500 });
    }

    // REST endpoints for debugging
    if (url.pathname === "/health") {
      return Response.json({ ok: true, uptime: process.uptime() });
    }
    if (url.pathname === "/api/state") {
      return Response.json({
        nodes: store.getSnapshot(),
        cityMeta: store.getCityMetaSnapshot(),
        cityMetrics: store.getCityMetricsSnapshot(),
        providers: [...store.providers.values()],
        logCount: store.logs.length,
      });
    }

    return new Response("Not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      if (ws.data.role === "provider") {
        conns.addProvider(ws);
        console.log(`Provider connected: ${ws.data.id}`);
      } else {
        conns.addFrontend(ws);
        console.log(`Frontend connected: ${ws.data.id}`);
        // Send initial snapshot + status
        conns.sendSnapshot(ws);
        conns.broadcastStatus();
      }
    },
    message(ws, message) {
      try {
        const msg = JSON.parse(String(message));
        if (ws.data.role === "provider") {
          conns.handleProviderMessage(ws, msg as ProviderMessage);
        } else {
          conns.handleFrontendMessage(ws, msg as FrontendMessage);
        }
      } catch (e) {
        console.error("Bad message:", e);
      }
    },
    close(ws) {
      console.log(`${ws.data.role} disconnected: ${ws.data.id}`);
      conns.remove(ws);
    },
  },
});

// Intervals
setInterval(() => conns.broadcastDelta(), 1_000);
setInterval(() => conns.broadcastSnapshot(), 5_000);
setInterval(() => store.checkStaleness(), 10_000);
setInterval(() => store.purgeStale(5 * 60_000), 60_000); // remove nodes unseen for 5 min

console.log(`Proxy running on port ${server.port}`);
