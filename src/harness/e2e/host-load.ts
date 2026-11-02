import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cpus, loadavg, totalmem } from "node:os";

/** A host this busy starved Firefox's content processes until reloads and boots timed out (research/05, Pitfalls). */
const MAX_LOAD_PER_CORE = 4;
const MAX_SWAP_SHARE_OF_RAM = 0.25;

/** Swap in use, in bytes, or undefined where it can't be read. */
function swapUsed(): number | undefined {
  try {
    if (process.platform === "darwin") {
      // e.g. "total = 7168.00M  used = 6148.81M  free = 1019.19M  (encrypted)"
      const used = /used = ([\d.]+)M/.exec(execFileSync("sysctl", ["-n", "vm.swapusage"], { encoding: "utf8" }));
      return used ? Number(used[1]) * 2 ** 20 : undefined;
    }
    if (process.platform === "linux") {
      const kb = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(readFileSync("/proc/meminfo", "utf8"))?.[1] ?? NaN);
      const used = (kb("SwapTotal") - kb("SwapFree")) * 1024;
      return Number.isNaN(used) ? undefined : used;
    }
  } catch {}
  return undefined;
}

/** Warns before the run if the host is loaded enough to make browser timeouts meaningless. */
export default function checkHostLoad(): void {
  const problems: string[] = [];
  const cores = cpus().length;
  const [load] = loadavg();
  if (load !== undefined && load / cores > MAX_LOAD_PER_CORE) problems.push(`load average ${load.toFixed(0)} on ${cores} cores`);
  const swap = swapUsed();
  if (swap !== undefined && swap / totalmem() > MAX_SWAP_SHARE_OF_RAM) problems.push(`${(swap / 2 ** 30).toFixed(1)} GB of swap in use (${(totalmem() / 2 ** 30).toFixed(0)} GB RAM)`);
  if (problems.length === 0) return;
  console.warn(
    `\n[harness] The host is overloaded: ${problems.join(", ")}. Firefox reloads and boots may time out ("Target page, context or browser has been closed", "boot did not finish within 30000ms") without a bug in the code; see research/05-sandboxing.md, Pitfalls.\n`,
  );
}
