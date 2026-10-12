import http from "node:http";
import type net from "node:net";

export interface EgressAttempt {
  /** "CONNECT" for tunnels (https:, wss:), else the HTTP method of a proxied http:/ws: request */
  method: string;
  /** host:port for tunnels, absolute URL otherwise */
  target: string;
  time: number;
}

export interface EgressSink {
  /** http://127.0.0.1:<port>, to be passed as the browser's proxy */
  proxyUrl: string;
  attempts: EgressAttempt[];
  close: () => Promise<void>;
}

/**
 * An HTTP proxy that records and refuses every request. Browsers launched
 * with it send all non-loopback traffic here (loopback bypasses proxies by
 * default), from every page, worker and service worker, so nothing leaves the
 * machine and every attempt is on record. Not covered: traffic that ignores
 * HTTP proxies, such as WebRTC.
 */
export async function startEgressSink(): Promise<EgressSink> {
  const attempts: EgressAttempt[] = [];
  const sockets = new Set<net.Socket>();
  const server = http.createServer((request, response) => {
    attempts.push({ method: request.method ?? "?", target: request.url ?? "?", time: Date.now() });
    response.writeHead(403, { "content-type": "text/plain" }).end("blocked by the harness egress sink\n");
  });
  const refuse = (request: http.IncomingMessage, socket: net.Socket) => {
    attempts.push({ method: request.method ?? "?", target: request.url ?? "?", time: Date.now() });
    socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
  };
  server.on("connect", refuse);
  server.on("upgrade", refuse);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as net.AddressInfo;
  return {
    proxyUrl: `http://127.0.0.1:${port}`,
    attempts,
    close: () =>
      new Promise((resolve) => {
        // Stop accepting first, so no connection slips in after the sweep.
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      }),
  };
}
