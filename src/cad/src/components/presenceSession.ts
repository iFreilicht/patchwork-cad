import { Presence, type AutomergeUrl, type DocHandle } from "@automerge/automerge-repo";
import type { ViewPresence } from "../types.ts";

/**
 * Collaborators' views of a model (research/13-collaboration.md, "A presence provider"): the
 * interface a `patchwork:presence` provider would offer, built here on one automerge `Presence` per
 * model document and tab, which all views of the model in the tab share. Each view has its own key,
 * so views don't overwrite each other, and closing one doesn't make the tab leave. The whole state
 * is re-sent every few seconds, which heals the `goodbye` of another tool's `Presence` on the same
 * document and keeps idle tabs from being pruned.
 */

/** One collaborator's view of the model. */
export interface PeerView {
  /** Unique per tab and view. */
  key: string;
  contactUrl: AutomergeUrl;
  color: string;
  state: ViewPresence;
}

/** The state a tab broadcasts on the `cad` channel. */
interface TabState {
  contactUrl: AutomergeUrl;
  views: Record<string, ViewPresence>;
}
type Channels = { cad: TabState | null };

export interface SessionOptions {
  heartbeatMs: number;
  peerTtlMs: number;
  /** How often the full state is re-sent. */
  resendMs: number;
  /** How long changes are batched before they are sent. */
  throttleMs: number;
}

const DEFAULTS: SessionOptions = { heartbeatMs: 2_000, peerTtlMs: 10_000, resendMs: 2_000, throttleMs: 30 };

/** CBOR, which ephemeral messages use, has no `undefined`; drop such fields. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Changes to a view's state; `undefined` removes a field. */
export type PresenceUpdate = { [K in keyof ViewPresence]?: ViewPresence[K] | undefined };

export interface SessionView {
  set(state: PresenceUpdate): void;
  leave(): void;
}

/** The presence of one model document in one tab, without Solid or the DOM, so that it can be tested with stub handles. */
export class PresenceSession {
  readonly #presence: Presence<Channels>;
  readonly #options: SessionOptions;
  readonly #views = new Map<string, ViewPresence>();
  readonly #listeners = new Set<() => void>();
  #contactUrl: AutomergeUrl | undefined;
  #flush: ReturnType<typeof setTimeout> | undefined;
  #resend: ReturnType<typeof setInterval> | undefined;
  #nextView = 0;
  /** For diagnosis: messages sent and received, and when. */
  readonly #stats = { sent: 0, lastSent: 0, received: 0, lastReceived: 0 };
  /** Called when the last view has left. */
  onEmpty: (() => void) | undefined;

  constructor(handle: DocHandle<unknown>, options: Partial<SessionOptions> = {}) {
    this.#options = { ...DEFAULTS, ...options };
    this.#presence = new Presence<Channels>({ handle });
    for (const event of ["update", "snapshot", "goodbye", "pruned"] as const) this.#presence.on(event, this.#changed);
    for (const event of ["update", "snapshot", "heartbeat"] as const)
      this.#presence.on(event, () => {
        this.#stats.received++;
        this.#stats.lastReceived = Date.now();
      });
  }

  /** Our identity; presence starts once it is known, and other tabs of the same contact are hidden. */
  setContact(contactUrl: AutomergeUrl): void {
    if (this.#contactUrl === contactUrl) return;
    this.#contactUrl = contactUrl;
    if (this.#views.size) this.start();
    this.#changed();
  }

  join(state: ViewPresence): SessionView {
    const id = `${this.#nextView++}-${Math.random().toString(36).slice(2, 8)}`;
    this.#views.set(id, state);
    this.start();
    this.#schedule();
    return {
      set: (partial) => {
        const current = this.#views.get(id);
        if (!current) return;
        // The JSON round trip drops the fields set to undefined.
        const next = plain({ ...current, ...partial, tool: current.tool }) as ViewPresence;
        if (JSON.stringify(next) === JSON.stringify(current)) return;
        this.#views.set(id, next);
        this.#schedule();
      },
      leave: () => {
        if (!this.#views.delete(id)) return;
        if (this.#views.size) this.#schedule();
        else {
          this.stop();
          this.onEmpty?.();
        }
      },
    };
  }

  /** Other users' views; views of our own contact, e.g. in another tab, are left out. */
  peers(): PeerView[] {
    if (!this.#presence.running) return [];
    return this.#presence.getPeerStates().peers.flatMap((peer) => {
      const tab = peer.value?.cad;
      if (!tab?.contactUrl || tab.contactUrl === this.#contactUrl) return [];
      return Object.entries(tab.views ?? {}).map(([viewId, state]) => ({ key: `${String(peer.peerId)}/${viewId}`, contactUrl: tab.contactUrl, color: presenceColor(tab.contactUrl), state }));
    });
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Starts sending once there is a view and a contact; also after `stop`, e.g. when a page comes back from the back/forward cache. */
  start(): void {
    if (this.#presence.running || !this.#contactUrl || !this.#views.size) return;
    this.#presence.start({ initialState: { cad: this.#state() }, heartbeatMs: this.#options.heartbeatMs, peerTtlMs: this.#options.peerTtlMs });
    this.#resend = setInterval(this.#send, this.#options.resendMs);
    this.#changed();
  }

  /** Sends a goodbye: the tab leaves the document. */
  stop(): void {
    clearTimeout(this.#flush);
    this.#flush = undefined;
    clearInterval(this.#resend);
    this.#resend = undefined;
    if (this.#presence.running) this.#presence.stop();
    this.#changed();
  }

  #state(): TabState | null {
    return this.#contactUrl ? plain({ contactUrl: this.#contactUrl, views: Object.fromEntries(this.#views) }) : null;
  }

  #schedule(): void {
    if (this.#flush !== undefined) return;
    this.#flush = setTimeout(this.#send, this.#options.throttleMs);
  }

  readonly #send = () => {
    clearTimeout(this.#flush);
    this.#flush = undefined;
    if (!this.#presence.running) return;
    this.#presence.broadcast("cad", this.#state());
    this.#stats.sent++;
    this.#stats.lastSent = Date.now();
  };

  /** The session's state, for diagnosis in the console (see `cadPresence` in presence.ts). */
  debug() {
    const ago = (t: number) => (t ? `${((Date.now() - t) / 1000).toFixed(1)} s ago` : "never");
    return {
      running: this.#presence.running,
      contactUrl: this.#contactUrl,
      views: Object.fromEntries(this.#views),
      sent: `${this.#stats.sent}, last ${ago(this.#stats.lastSent)}`,
      received: `${this.#stats.received}, last ${ago(this.#stats.lastReceived)}`,
      peers: this.#presence.getPeerStates().peers.map((p) => ({
        peerId: String(p.peerId),
        contactUrl: p.value?.cad?.contactUrl,
        hidden: p.value?.cad?.contactUrl === this.#contactUrl ? "own contact" : !p.value?.cad ? "no cad state" : undefined,
        views: Object.keys(p.value?.cad?.views ?? {}).length,
        lastActive: ago(p.lastActiveAt),
      })),
    };
  }

  readonly #changed = () => {
    for (const listener of this.#listeners) listener();
  };
}

// Patchwork's presence colours (patchwork-base account/src/user-colors.ts), hashed from the contact URL
// as on Patchwork's text carets, for contacts who chose no colour (see `contactColor` in presence.ts).
const PALETTE = [
  "hsl(200, 70%, 50%)",
  "hsl(10, 75%, 58%)",
  "hsl(145, 70%, 45%)",
  "hsl(270, 70%, 55%)",
  "hsl(38, 85%, 50%)",
  "hsl(350, 70%, 55%)",
  "hsl(178, 70%, 45%)",
  "hsl(235, 70%, 58%)",
  "hsl(85, 70%, 45%)",
  "hsl(310, 70%, 55%)",
  "hsl(25, 80%, 52%)",
  "hsl(188, 75%, 48%)",
];

export function presenceColor(contactUrl: string): string {
  const hash = Math.abs(contactUrl.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0));
  return PALETTE[hash % PALETTE.length]!;
}
