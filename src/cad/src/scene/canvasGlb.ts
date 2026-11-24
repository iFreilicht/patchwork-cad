// A model's image canvases (research/21, "Canvas") in its scene content (research/23-scene-editing.md,
// G1): each image read at its version, drawn as the editor draws it, and placed where the editor
// places it, on an origin plane or on a face the build located. Live documents on canvases aren't
// images and aren't in it. Needs the DOM: an SVG is drawn on a canvas, as in the editor.

import type { DocHandle, UrlHeads } from "@automerge/automerge-repo";
import { drawImage, frameOfFace, isImage } from "../components/canvases.ts";
import { measureSvg } from "../components/canvases.ts";
import { docOf, fileBytes, fileKind, fileText, headsOf, isFile } from "../components/imports.ts";
import type { MeshedShape, RefData } from "../kernel/protocol.ts";
import { canvasCorners, canvases, isFrame, placementOf } from "../model/canvases.ts";
import type { CadModelDoc, StoredCanvas } from "../types.ts";
import type { Located } from "./kernel.ts";
import type { GlbCanvas } from "./modelGlb.ts";

type Repo = typeof globalThis.repo;

/** The canvases that lie on faces, whose references the build locates, in the order of `canvases(doc)`'s. */
export function faceRefsOf(doc: CadModelDoc | undefined): { id: string; ref: RefData }[] {
  return canvases(doc).flatMap((c) => (!isFrame(c.plane) && c.plane.entity ? [{ id: c.id, ref: c.plane.entity }] : []));
}

/** The image documents of a model's canvases that it follows, without heads: they change what is built. */
export const canvasImages = (doc: CadModelDoc | undefined): string[] => [...new Set(canvases(doc).flatMap((c) => (headsOf(c.image) ? [] : [docOf(c.image) ?? c.image])))];

type Drawn = { bytes: Uint8Array; mimeType: "image/png" | "image/jpeg"; box: { x: number; y: number; width: number; height: number }; elements: Awaited<ReturnType<typeof measureSvg>> | undefined; drawing: boolean };

/** Images drawn already, by URL and version: a rebuild of the model doesn't draw them again. */
const drawnImages = new Map<string, Promise<Drawn | string>>();
const KEEP = 16;

const pngOf = (canvas: HTMLCanvasElement) =>
  new Promise<Uint8Array>((resolve, reject) => canvas.toBlob((blob) => (blob ? blob.arrayBuffer().then((b) => resolve(new Uint8Array(b)), reject) : reject(new Error("it can't be drawn as a PNG"))), "image/png"));

/** An image document's content at `url`'s version, drawn: a PNG or JPEG as it is, anything else as a PNG; or why it isn't an image. */
async function readImage(url: string, repo: NonNullable<Repo>): Promise<Drawn | string> {
  const doc = docOf(url);
  if (!doc) return "its URL isn't a document's";
  const handle = (await repo.find<unknown>(doc)) as DocHandle<unknown> & { view?(heads: UrlHeads): DocHandle<unknown> };
  const heads = headsOf(url);
  const value = heads && handle.view ? handle.view(heads).doc() : handle.doc();
  if (!isImage(value) || !isFile(value)) return "it isn't an image";
  const bytes = fileBytes(value);
  if (!bytes) return "it has no content";
  const svg = fileKind(value) === "svg" ? (fileText(value) ?? "") : undefined;
  const type = typeof value.mimeType === "string" ? value.mimeType.split(";")[0]!.trim().toLowerCase() : "";
  const drawn = await drawImage(bytes, svg !== undefined ? "image/svg+xml" : type || "application/octet-stream", svg);
  const elements = svg !== undefined ? await measureSvg(svg).catch(() => undefined) : undefined;
  // A PNG or JPEG is kept as it is; an SVG, a drawing, is drawn for a light background, as its editors draw them.
  if (type === "image/png" || type === "image/jpeg") return { bytes, mimeType: type, box: drawn.box, elements, drawing: false };
  return { bytes: await pngOf(drawn.image), mimeType: "image/png", box: drawn.box, elements, drawing: svg !== undefined };
}

function imageOf(url: string, repo: NonNullable<Repo>): Promise<Drawn | string> {
  let drawn = drawnImages.get(url);
  if (!drawn) {
    drawn = readImage(url, repo).catch((error: unknown) => String((error as Error)?.message ?? error));
    drawnImages.set(url, drawn);
    // The oldest go first.
    for (const key of drawnImages.keys()) if (drawnImages.size > KEEP) drawnImages.delete(key);
  }
  return drawn;
}

/**
 * The model's image canvases as a build places them: on their planes or located faces (`located`,
 * in the order of `faceRefsOf`), with their images; and why any aren't there.
 */
export async function placedCanvases(doc: CadModelDoc, repo: Repo, shapes: readonly MeshedShape[], located: Located): Promise<{ canvases: GlbCanvas[]; problems: string[] }> {
  const onFaces = faceRefsOf(doc);
  const out: GlbCanvas[] = [];
  const problems: string[] = [];
  for (const canvas of canvases(doc) as StoredCanvas[]) {
    const say = (why: string) => problems.push(`canvas ${canvas.name}: ${why}`);
    const image = repo ? await imageOf(canvas.image, repo) : "it can't be read outside Patchwork";
    // Live documents are left out (research/23); the others say why they aren't shown.
    if (typeof image === "string") {
      if (image !== "it isn't an image") say(image);
      continue;
    }
    let frame = isFrame(canvas.plane) ? canvas.plane : undefined;
    if (!frame) {
      const found = located[onFaces.findIndex((f) => f.id === canvas.id)]?.find((p) => p.indices.length);
      const shape = found && shapes.find((s) => s.body === found.body);
      if (!found || !shape) {
        say("its face is gone");
        continue;
      }
      frame = frameOfFace(shape, found.indices[0]!);
      if (!frame) {
        say("its face isn't planar");
        continue;
      }
    }
    const { placement } = placementOf(canvas, image.box, image.elements);
    out.push({ id: canvas.id, name: canvas.name, corners: canvasCorners(placement, frame, image.box), normal: frame.normal, image: image.bytes, mimeType: image.mimeType, opacity: canvas.opacity, drawing: image.drawing });
  }
  return { canvases: out, problems };
}
