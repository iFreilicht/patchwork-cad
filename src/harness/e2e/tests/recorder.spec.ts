import { expect, test } from "../fixtures.ts";
import { PROBES, probeHost, startProbeServer, type Probe } from "../probe-server.ts";

// The egress sink must see traffic from every kind of context; the Playwright
// log's coverage is browser-specific and only recorded, not required.
test.use({ egressAllowed: true });

test("the egress sink sees off-machine traffic from every context", async ({ users, egress }, testInfo) => {
  const probeServer = await startProbeServer();
  try {
    const [user] = await users(1);
    if (!user) throw new Error("no user");
    await user.page.goto(probeServer.url);
    await user.page.waitForFunction(() => (window as { probesStarted?: boolean }).probesStarted === true);

    const sinkSaw = (probe: Probe) => egress.attempts.some((a) => a.target.includes(probeHost(probe)));
    await expect.poll(() => PROBES.filter((p) => !sinkSaw(p)), { timeout: 15_000 }).toEqual([]);

    const coverage = Object.fromEntries(
      PROBES.map((probe) => {
        const seen = user.networkLog.entries.filter((e) => URL.parse(e.url)?.hostname === probeHost(probe));
        return [probe, seen.length ? seen.map((e) => `${e.kind}/${e.source}`).join(",") : "-"];
      }),
    );
    testInfo.annotations.push({ type: "playwright-coverage", description: JSON.stringify(coverage) });
    console.log(`${testInfo.project.name} playwright coverage: ${JSON.stringify(coverage, null, 1)}`);
  } finally {
    await probeServer.close();
  }
});
