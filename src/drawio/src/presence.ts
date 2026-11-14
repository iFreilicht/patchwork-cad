/**
 * Collaborators in a diagram, over Patchwork's presence (automerge-repo's `Presence` on the
 * document, as the CAD tool's): each tab sends its contact, the page it shows, its pointer in the
 * diagram's coordinates and the cells it has selected, and gets everyone else's. Tabs of the same
 * contact are left out, as on Patchwork's text carets.
 */
import { Presence, type AutomergeUrl, type DocHandle } from "@automerge/automerge-repo";

/** What a tab shows the others. */
export interface DiagramView {
  page?: string | undefined;
  /** The pointer in the page's coordinates, while it is over the diagram. */
  cursor?: [number, number] | undefined;
  selection?: string[] | undefined;
}

export interface Peer {
  key: string;
  contactUrl: AutomergeUrl;
  view: DiagramView;
}

type TabState = { contactUrl: AutomergeUrl } & DiagramView;
type Channels = { drawio: TabState | null };

const HEARTBEAT_MS = 2_000;
const PEER_TTL_MS = 10_000;
const THROTTLE_MS = 40;

/** CBOR, which ephemeral messages use, has no `undefined`. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class DiagramPresence {
  readonly #presence: Presence<Channels>;
  #contactUrl: AutomergeUrl | undefined;
  #view: DiagramView = {};
  #flush: ReturnType<typeof setTimeout> | undefined;
  #listeners = new Set<() => void>();

  constructor(handle: DocHandle<unknown>) {
    this.#presence = new Presence<Channels>({ handle });
    for (const event of ["update", "snapshot", "goodbye", "pruned"] as const) this.#presence.on(event, () => this.#changed());
  }

  /** Our identity: presence starts once it is known. */
  setContact(contactUrl: AutomergeUrl): void {
    if (this.#contactUrl === contactUrl) return;
    this.#contactUrl = contactUrl;
    if (!this.#presence.running) this.#presence.start({ initialState: { drawio: this.#state() }, heartbeatMs: HEARTBEAT_MS, peerTtlMs: PEER_TTL_MS });
    this.#changed();
  }

  set(view: DiagramView): void {
    const next = plain({ ...this.#view, ...view });
    if (JSON.stringify(next) === JSON.stringify(this.#view)) return;
    this.#view = next;
    if (this.#flush === undefined) this.#flush = setTimeout(this.#send, THROTTLE_MS);
  }

  peers(): Peer[] {
    if (!this.#presence.running) return [];
    return this.#presence.getPeerStates().peers.flatMap((peer) => {
      const state = peer.value?.drawio;
      if (!state?.contactUrl || state.contactUrl === this.#contactUrl) return [];
      const { contactUrl, ...view } = state;
      return [{ key: String(peer.peerId), contactUrl, view }];
    });
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  stop(): void {
    clearTimeout(this.#flush);
    if (this.#presence.running) this.#presence.stop();
  }

  #state(): TabState | null {
    return this.#contactUrl ? plain({ contactUrl: this.#contactUrl, ...this.#view }) : null;
  }

  readonly #send = () => {
    this.#flush = undefined;
    if (this.#presence.running) this.#presence.broadcast("drawio", this.#state());
  };

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }
}

// Patchwork's presence colours (patchwork-base account/src/user-colors.ts), hashed from the contact URL
// for contacts who chose none, as the CAD tool and Patchwork's text carets do.
const PALETTE = ["hsl(200, 70%, 50%)", "hsl(10, 75%, 58%)", "hsl(145, 70%, 45%)", "hsl(270, 70%, 55%)", "hsl(38, 85%, 50%)", "hsl(350, 70%, 55%)", "hsl(178, 70%, 45%)", "hsl(235, 70%, 58%)", "hsl(85, 70%, 45%)", "hsl(310, 70%, 55%)", "hsl(25, 80%, 52%)", "hsl(188, 75%, 48%)"];

export function presenceColor(contactUrl: string): string {
  const hash = Math.abs(contactUrl.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0));
  return PALETTE[hash % PALETTE.length]!;
}
