import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";
import { startEgressSink, type EgressSink } from "./egress.ts";
import { publishModule, registerModule, type AutomergeUrl } from "./modules.ts";
import { NetworkLog } from "./network-log.ts";
import { startStack, type Stack } from "./stack.ts";

export interface User {
  context: BrowserContext;
  page: Page;
  networkLog: NetworkLog;
}

interface WorkerFixtures {
  /** Tool packages the site serves as static modules (see server.ts), by name. */
  siteModules: Record<string, string>;
  localStack: Stack;
  /** Publishes a tool directory to the worker's sync server, once per directory. */
  publishModule: (dir: string) => Promise<AutomergeUrl>;
}

interface TestFixtures {
  /** Set to true in tests that deliberately send traffic off the machine. */
  egressAllowed: boolean;
  egress: EgressSink;
  /** The default context's network log. */
  networkLog: NetworkLog;
  /** Creates n independent browser profiles (contexts), each with its own network log. */
  users: (n: number) => Promise<User[]>;
  /** Publishes a tool directory and registers it with each (booted) user's account. */
  installModule: (dir: string, ...users: User[]) => Promise<AutomergeUrl>;
}

export const LOOPBACK = "localhost,127.0.0.1,[::1]";

export const test = base.extend<TestFixtures, WorkerFixtures>({
  siteModules: [{}, { option: true, scope: "worker" }],

  localStack: [
    async ({ siteModules }, use) => {
      const stack = await startStack({ modules: siteModules });
      await use(stack);
      await stack.stop();
    },
    { scope: "worker", timeout: 120_000 },
  ],

  publishModule: [
    async ({ localStack }, use) => {
      const published = new Map<string, Promise<AutomergeUrl>>();
      await use((dir) => {
        if (!published.has(dir)) published.set(dir, publishModule(dir, localStack.subductionUrl));
        return published.get(dir)!;
      });
    },
    { scope: "worker" },
  ],

  installModule: async ({ publishModule }, use) => {
    await use(async (dir, ...users) => {
      const url = await publishModule(dir);
      for (const user of users) await registerModule(user.page, url);
      return url;
    });
  },

  baseURL: async ({ localStack }, use) => use(localStack.siteUrl),

  egressAllowed: [false, { option: true }],

  egress: [
    async ({ egressAllowed }, use, testInfo) => {
      const sink = await startEgressSink();
      await use(sink);
      await sink.close();
      if (sink.attempts.length) {
        await testInfo.attach("egress.json", { body: JSON.stringify(sink.attempts, null, 2), contentType: "application/json" });
      }
      if (!egressAllowed) expect(sink.attempts, "requests that tried to leave the machine").toEqual([]);
    },
    { auto: true },
  ],

  proxy: async ({ egress }, use) => use({ server: egress.proxyUrl, bypass: LOOPBACK }),

  networkLog: async ({ context, egressAllowed }, use, testInfo) => {
    const log = new NetworkLog(context);
    await use(log);
    await attachLog(testInfo, "default", log);
    if (!egressAllowed) expect(log.nonLocal(), "non-local traffic seen by Playwright").toEqual([]);
  },

  users: async ({ browser, egress, egressAllowed, localStack, contextOptions }, use, testInfo) => {
    const created: User[] = [];
    await use(async (n) => {
      const batch: User[] = [];
      for (let i = 0; i < n; i++) {
        const context = await browser.newContext({
          ...contextOptions,
          baseURL: localStack.siteUrl,
          serviceWorkers: "allow",
          proxy: { server: egress.proxyUrl, bypass: LOOPBACK },
        });
        const networkLog = new NetworkLog(context);
        batch.push({ context, page: await context.newPage(), networkLog });
      }
      created.push(...batch);
      return batch;
    });
    await Promise.all(created.map((user) => user.context.close()));
    for (const [i, user] of created.entries()) await attachLog(testInfo, `user-${i}`, user.networkLog);
    if (!egressAllowed) {
      for (const [i, user] of created.entries()) {
        expect(user.networkLog.nonLocal(), `non-local traffic seen by Playwright (user ${i})`).toEqual([]);
      }
    }
  },
});

async function attachLog(testInfo: { attach: (name: string, o: { body: string; contentType: string }) => Promise<void> }, name: string, log: NetworkLog) {
  await testInfo.attach(`network-${name}.json`, {
    body: JSON.stringify({ summary: log.summary(), entries: log.entries }, null, 2),
    contentType: "application/json",
  });
}

export { expect };
