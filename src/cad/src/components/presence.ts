import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import type { AutomergeUrl, DocHandle } from "@automerge/automerge-repo";
import { subscribe } from "@inkandswitch/patchwork-providers";
import type { MeshedShape, RefData } from "../kernel/protocol.ts";
import type { Model } from "./createModel.ts";
import type { ViewPresence } from "../types.ts";
import type { Highlight, PeerMarker } from "./Viewer.tsx";
import { PresenceSession, type PeerView, type PresenceUpdate } from "./presenceSession.ts";

export type { PeerView } from "./presenceSession.ts";
export { presenceColor } from "./presenceSession.ts";

/** One session per model document in this tab, shared by every view of it in this bundle (the editor and the viewer). */
const sessions = new Map<AutomergeUrl, PresenceSession>();

if (typeof window !== "undefined") {
  // For diagnosis in the console: `cadPresence()` shows each model's session in this tab.
  (window as Window & { cadPresence?: () => unknown }).cadPresence = () => Object.fromEntries([...sessions].map(([url, s]) => [url, s.debug()]));
  window.addEventListener("pagehide", () => sessions.forEach((s) => s.stop()));
  window.addEventListener("pageshow", (event) => event.persisted && sessions.forEach((s) => s.start()));
}

export interface ViewPresenceHandle {
  set(state: PresenceUpdate): void;
  /** Other users' views of the model. */
  peers: Accessor<PeerView[]>;
}

/** Joins the model's presence with one view, for as long as the calling Solid owner lives. */
export function joinPresence(element: HTMLElement, handle: DocHandle<unknown>, tool: ViewPresence["tool"]): ViewPresenceHandle {
  let session = sessions.get(handle.url);
  if (!session) {
    const created = new PresenceSession(handle);
    created.onEmpty = () => sessions.get(handle.url) === created && sessions.delete(handle.url);
    sessions.set(handle.url, created);
    session = created;
  }
  const view = session.join({ tool });
  const [peers, setPeers] = createSignal<PeerView[]>(session.peers());
  const s = session;
  const off = s.onChange(() => setPeers(s.peers()));
  const unsubscribe = subscribe<AutomergeUrl>(element, { type: "patchwork:contact" }, (url) => url && s.setContact(url));
  onCleanup(() => {
    unsubscribe();
    off();
    view.leave();
  });
  return { set: view.set, peers };
}

/** A contact's name on a pill in their colour: Patchwork's `contact-cursor` tool, as on its text carets. */
export function contactToken(contactUrl: string): HTMLElement {
  const token = document.createElement("patchwork-view");
  token.className = "cad-model__contact";
  token.setAttribute("tool-id", "contact-cursor");
  token.setAttribute("doc-url", contactUrl);
  return token;
}

export function ContactToken(props: { contactUrl: string }) {
  const token = contactToken(props.contactUrl);
  createEffect(() => token.getAttribute("doc-url") !== props.contactUrl && token.setAttribute("doc-url", props.contactUrl));
  return token;
}

/**
 * Collaborators' hovered and selected faces and edges, and what their hovered features made, as
 * highlights in their colours on the shapes this view shows. Faces and edges are references, which
 * the worker resolves against those shapes, so they show also when the collaborator's model is at
 * another build or rolled back to another feature; features are names.
 */
export function createPeerHighlights(model: Model, shown: Accessor<MeshedShape[]>, peers: Accessor<PeerView[]>): Accessor<Highlight[]> {
  /** The references to resolve, as a string, so that the worker is asked only when they change, not on every pointer move. */
  const refs = createMemo(() => JSON.stringify(peers().flatMap((p) => [p.state.hover, p.state.selected].flatMap((ref) => (ref ? [{ ref, color: p.color }] : [])))));
  const [located, setLocated] = createSignal<Highlight[]>([]);
  let request = 0;
  createEffect(() => {
    const wanted = JSON.parse(refs()) as { ref: RefData; color: string }[];
    const bodies = [...new Set(shown().flatMap((s) => (s.body ? [s.body] : [])))];
    const id = ++request;
    if (!wanted.length || !bodies.length) {
      setLocated([]);
      return;
    }
    model.engine.locate(bodies, wanted.map((w) => w.ref)).then(
      (found) => id === request && setLocated(found.flatMap((parts, i) => parts.map(({ body, indices }) => ({ body, kind: wanted[i]!.ref.kind, indices, style: "peer" as const, color: wanted[i]!.color })))),
      () => undefined,
    );
  });
  const features = () =>
    peers().flatMap(({ state, color }) =>
      (state.features ?? []).flatMap((name) =>
        shown().flatMap((s) => {
          const owned = s.body ? s.features?.[name] : undefined;
          if (!s.body || !owned) return [];
          return [
            { body: s.body, kind: "face" as const, indices: owned.faces, style: "peer" as const, color },
            { body: s.body, kind: "edge" as const, indices: owned.edges, style: "peer" as const, color },
          ];
        }),
      ),
    );
  return () => [...located(), ...features()];
}

/** Collaborators' pointers on the model. */
export const peerMarkers = (peers: PeerView[]): PeerMarker[] => peers.flatMap((p) => (p.state.pointer ? [{ key: p.key, point: p.state.pointer, color: p.color, contactUrl: p.contactUrl }] : []));
