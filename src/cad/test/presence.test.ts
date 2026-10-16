// The presence layer of research/13-collaboration.md, between two tabs whose handles are stubbed: a
// tab's broadcast reaches every handle of the other tab, as the handle registry fans ephemeral
// messages out to all handles of a document.
import { EventEmitter } from "node:events";
import { Presence, type AutomergeUrl, type DocHandle } from "@automerge/automerge-repo";
import { afterEach, expect, test, vi } from "vitest";
import { PresenceSession, presenceColor } from "../src/components/presenceSession.ts";

class Tab {
  readonly handles: EventEmitter[] = [];
  other: Tab | undefined;
  constructor(readonly peerId: string) {}
  handle(): DocHandle<unknown> {
    const h = new EventEmitter() as EventEmitter & { broadcast(message: unknown): void; off: EventEmitter["removeListener"] };
    h.broadcast = (message) => {
      // Ephemeral messages are CBOR-encoded; a JSON round trip stands in for that.
      const copy = JSON.parse(JSON.stringify(message)) as unknown;
      for (const o of this.other?.handles ?? []) o.emit("ephemeral-message", { senderId: this.peerId, message: copy });
    };
    this.handles.push(h);
    return h as unknown as DocHandle<unknown>;
  }
}

const OPTIONS = { heartbeatMs: 100, peerTtlMs: 500, resendMs: 100, throttleMs: 5 };
const ALICE = "automerge:alice" as AutomergeUrl;
const BOB = "automerge:bob" as AutomergeUrl;
const sessions: PresenceSession[] = [];

function tabs() {
  const a = new Tab("A");
  const b = new Tab("B");
  a.other = b;
  b.other = a;
  const sa = new PresenceSession(a.handle(), OPTIONS);
  const sb = new PresenceSession(b.handle(), OPTIONS);
  sa.setContact(ALICE);
  sb.setContact(BOB);
  sessions.push(sa, sb);
  return { a, b, sa, sb };
}

afterEach(() => {
  for (const s of sessions.splice(0)) s.stop();
  vi.useRealTimers();
});

const states = (s: PresenceSession) => s.peers().map((p) => p.state);

test("two views of one tab are both visible, and closing one removes only it", async () => {
  vi.useFakeTimers();
  const { sa, sb } = tabs();
  sb.join({ tool: "viewer" });
  const editor = sa.join({ tool: "editor" });
  const viewer = sa.join({ tool: "viewer" });
  editor.set({ open: "extrude1" });
  viewer.set({ pointer: [1, 2, 3] });
  await vi.advanceTimersByTimeAsync(50);
  expect(states(sb)).toEqual(expect.arrayContaining([{ tool: "editor", open: "extrude1" }, { tool: "viewer", pointer: [1, 2, 3] }]));
  expect(sb.peers().every((p) => p.contactUrl === ALICE && p.color === presenceColor(ALICE))).toBe(true);
  viewer.leave();
  await vi.advanceTimersByTimeAsync(50);
  expect(states(sb)).toEqual([{ tool: "editor", open: "extrude1" }]);
  editor.leave();
  await vi.advanceTimersByTimeAsync(50);
  expect(states(sb)).toEqual([]);
});

test("another tool's Presence on the same document stopping costs at most one re-send", async () => {
  vi.useFakeTimers();
  const { a, sa, sb } = tabs();
  sb.join({ tool: "viewer" });
  sa.join({ tool: "editor", open: "notch" });
  // Like doc-presence on the same document in tab A.
  const foreign = new Presence({ handle: a.handle() });
  foreign.start({ initialState: { name: "Alice" }, heartbeatMs: 100 });
  await vi.advanceTimersByTimeAsync(50);
  expect(states(sb)).toEqual([{ tool: "editor", open: "notch" }]);
  foreign.stop();
  expect(states(sb)).toEqual([]);
  await vi.advanceTimersByTimeAsync(OPTIONS.resendMs + 10);
  expect(states(sb)).toEqual([{ tool: "editor", open: "notch" }]);
});

test("an idle tab stays visible past the peer TTL", async () => {
  vi.useFakeTimers();
  const { sa, sb } = tabs();
  sb.join({ tool: "viewer" });
  sa.join({ tool: "editor" });
  for (let t = 0; t < 3 * OPTIONS.peerTtlMs; t += 50) {
    await vi.advanceTimersByTimeAsync(50);
    if (t > 50) expect(states(sb)).toEqual([{ tool: "editor" }]);
  }
});

test("views of the same contact, e.g. another tab of the same user, are hidden", async () => {
  vi.useFakeTimers();
  const { sa, sb } = tabs();
  sb.setContact(ALICE);
  sb.join({ tool: "viewer" });
  sa.join({ tool: "editor" });
  await vi.advanceTimersByTimeAsync(50);
  expect(sb.peers()).toEqual([]);
});

test("the colour is Patchwork's palette hash of the contact URL", () => {
  // generateColorFromString in patchwork-base account/src/user-colors.ts: the sum of the character codes, modulo 12.
  const sum = [...ALICE].reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const palette = ["hsl(200, 70%, 50%)", "hsl(10, 75%, 58%)", "hsl(145, 70%, 45%)", "hsl(270, 70%, 55%)", "hsl(38, 85%, 50%)", "hsl(350, 70%, 55%)", "hsl(178, 70%, 45%)", "hsl(235, 70%, 58%)", "hsl(85, 70%, 45%)", "hsl(310, 70%, 55%)", "hsl(25, 80%, 52%)", "hsl(188, 75%, 48%)"];
  expect(presenceColor(ALICE)).toBe(palette[sum % 12]);
});
