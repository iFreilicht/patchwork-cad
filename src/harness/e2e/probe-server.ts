import http from "node:http";
import type net from "node:net";

/**
 * A page that sends traffic off the machine from every kind of browser
 * context, to measure what the recorders see. Each probe targets its own
 * host under the reserved `.test` TLD, so attempts are attributable and can
 * never resolve.
 */
export const PROBES = [
  "page-fetch",
  "page-image",
  "page-beacon",
  "page-websocket",
  "dedicated-worker-fetch",
  "dedicated-worker-websocket",
  "shared-worker-fetch",
  "shared-worker-websocket",
  "service-worker-fetch",
  "service-worker-websocket",
] as const;
export type Probe = (typeof PROBES)[number];

export const probeHost = (probe: Probe) => `${probe}.egress.test`;

// Runs in any worker scope: fetch and open a WebSocket for the given prefix.
const workerProbe = (prefix: string) => `
  const probe = (name) => {
    fetch("http://" + name + "-fetch.egress.test/").catch(() => {});
    try { new WebSocket("ws://" + name + "-websocket.egress.test/"); } catch {}
  };
  ${prefix}
`;

const FILES: Record<string, [string, string]> = {
  "/": [
    "text/html",
    `<!doctype html><script type="module">
      const host = (name) => "http://" + name + ".egress.test/";
      fetch(host("page-fetch")).catch(() => {});
      new Image().src = host("page-image");
      navigator.sendBeacon(host("page-beacon"), "x");
      new WebSocket("ws://page-websocket.egress.test/");
      new Worker("/dedicated.js");
      new SharedWorker("/shared.js").port.start();
      const registration = await navigator.serviceWorker.register("/sw.js");
      const worker = registration.installing ?? registration.waiting ?? registration.active;
      const active = () => worker.state === "activated";
      if (!active()) await new Promise((r) => worker.addEventListener("statechange", () => active() && r()));
      worker.postMessage("probe");
      window.probesStarted = true;
    </script>`,
  ],
  "/dedicated.js": ["text/javascript", workerProbe(`probe("dedicated-worker");`)],
  "/shared.js": ["text/javascript", workerProbe(`probe("shared-worker");`)],
  "/sw.js": [
    "text/javascript",
    workerProbe(`
      self.addEventListener("install", () => self.skipWaiting());
      self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
      self.addEventListener("message", () => probe("service-worker"));
    `),
  ],
};

export async function startProbeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    const file = FILES[new URL(request.url ?? "/", "http://x").pathname];
    if (!file) return void response.writeHead(404).end();
    response.writeHead(200, { "content-type": file[0], "cache-control": "no-store" }).end(file[1]);
  });
  await new Promise<void>((r) => server.listen(0, "localhost", r));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `http://localhost:${port}/`,
    close: () => new Promise((r) => (server.closeAllConnections(), server.close(() => r()))),
  };
}
