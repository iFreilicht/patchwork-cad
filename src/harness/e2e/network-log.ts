import type { BrowserContext, Page, Request } from "@playwright/test";

export interface NetworkEntry {
  kind: "request" | "websocket";
  /** what Playwright attributes the traffic to */
  source: "page" | "service-worker" | "worker" | "unknown";
  url: string;
  failure?: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const NON_NETWORK_SCHEMES = new Set(["data:", "blob:", "about:"]);

export function isLocal(url: string): boolean {
  const parsed = URL.parse(url);
  if (!parsed) return false;
  return NON_NETWORK_SCHEMES.has(parsed.protocol) || LOCAL_HOSTS.has(parsed.hostname);
}

function source(request: Request): NetworkEntry["source"] {
  if (request.serviceWorker()) return "service-worker";
  try {
    request.frame();
    return "page";
  } catch {
    return "unknown";
  }
}

/**
 * Records what Playwright reports about a context's traffic. Coverage
 * differs per browser, so the egress sink is the ground truth for
 * "nothing left the machine"; this log adds attribution.
 */
export class NetworkLog {
  readonly entries: NetworkEntry[] = [];

  constructor(context: BrowserContext) {
    context.on("request", (request) => {
      this.entries.push({ kind: "request", source: source(request), url: request.url() });
    });
    context.on("requestfailed", (request) => {
      const entry = this.entries.findLast((e) => e.kind === "request" && e.url === request.url());
      if (entry) entry.failure = request.failure()?.errorText ?? "failed";
    });
    const watchPage = (page: Page) => {
      page.on("websocket", (ws) => this.entries.push({ kind: "websocket", source: "page", url: ws.url() }));
      // Firefox reports a worker's URL as given to the constructor, possibly relative.
      page.on("worker", (worker) =>
        this.entries.push({ kind: "request", source: "worker", url: new URL(worker.url(), page.url()).href }),
      );
    };
    context.pages().forEach(watchPage);
    context.on("page", watchPage);
  }

  nonLocal(): NetworkEntry[] {
    return this.entries.filter((e) => !isLocal(e.url));
  }

  summary(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const e of this.entries) {
      const key = `${e.kind}/${e.source}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }
}
