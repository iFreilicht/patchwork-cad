/** Time per recorded change and per undo press in large documents with long histories (research/16-undo-redo.md). */
import * as A from "@automerge/automerge";
import { UndoManager } from "./src/index.ts";
import { Peer } from "./test/peers.ts";
for (const [chars, changes] of [[10_000, 1_000], [100_000, 10_000]] as const) {
  const p = new Peer(A.from<{ t: string; store: Record<string, { x: number; y: number }> }>({ t: "x".repeat(chars), store: {} }));
  let now = 0;
  const u = new UndoManager(p, { now: () => now, groupDelayMs: 0 });
  let t0 = performance.now();
  for (let i = 0; i < changes; i++) {
    now += 1000;
    if (i % 2) p.change((d) => A.splice(d, ["t"], (i * 7919) % chars, 0, "ab"));
    else p.change((d) => (d.store[`s${i % 200}`] = { x: i, y: i }));
  }
  const record = (performance.now() - t0) / changes;
  const times: number[] = [];
  for (let i = 0; i < 50; i++) {
    t0 = performance.now();
    u.undo();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  console.log(`${chars} chars, ${changes} changes: recording ${record.toFixed(2)} ms/change, undo median ${times[25]!.toFixed(1)} ms, max ${times.at(-1)!.toFixed(1)} ms`);
}
