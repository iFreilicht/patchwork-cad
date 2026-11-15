/**
 * The fonts that SVG texts are drawn in (research/21, "Sketch from a drawing"): Liberation Sans, Serif
 * and Mono from the devshell (`CAD_FONTS` in flake.nix), which the build bundles, and which have the
 * metrics of Arial, Times New Roman and Courier New. Loaded once, by the first build that has a text.
 */
import { registerFont } from "@patchwork-cad/features";
import sans from "cad-fonts/LiberationSans-Regular.ttf?url";
import sansBold from "cad-fonts/LiberationSans-Bold.ttf?url";
import sansItalic from "cad-fonts/LiberationSans-Italic.ttf?url";
import sansBoldItalic from "cad-fonts/LiberationSans-BoldItalic.ttf?url";
import serif from "cad-fonts/LiberationSerif-Regular.ttf?url";
import serifBold from "cad-fonts/LiberationSerif-Bold.ttf?url";
import serifItalic from "cad-fonts/LiberationSerif-Italic.ttf?url";
import serifBoldItalic from "cad-fonts/LiberationSerif-BoldItalic.ttf?url";
import mono from "cad-fonts/LiberationMono-Regular.ttf?url";
import monoBold from "cad-fonts/LiberationMono-Bold.ttf?url";
import monoItalic from "cad-fonts/LiberationMono-Italic.ttf?url";
import monoBoldItalic from "cad-fonts/LiberationMono-BoldItalic.ttf?url";
import type { ImportedModule } from "./imports.ts";

const URLS = [sans, sansBold, sansItalic, sansBoldItalic, serif, serifBold, serifItalic, serifBoldItalic, mono, monoBold, monoItalic, monoBoldItalic];

let loaded: Promise<void> | undefined;

/** Registers the fonts with the feature library, once; a font that can't be fetched is left out, and texts say what they are drawn in instead. */
export const loadFonts = (): Promise<void> =>
  (loaded ??= Promise.all(
    URLS.map(async (url) => {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${response.status}`);
        registerFont(new Uint8Array(await response.arrayBuffer()));
      } catch (error) {
        console.warn(`patchwork-cad: the font ${url} can't be loaded`, error);
      }
    }),
  ).then(() => undefined));

const TEXT = /<(?:\w+:)?text[\s>]/;
const decoder = new TextDecoder();

/** Whether a model or the documents it imports may draw a text: an SVG `<text>` in its code, or in a file it imports. */
export function mayDrawText(source: string, imports: Record<string, ImportedModule>): boolean {
  if (TEXT.test(source)) return true;
  return Object.values(imports).some((m) => (m.kind === "text" ? TEXT.test(m.text) : m.kind === "bytes" ? TEXT.test(decoder.decode(m.bytes)) : false));
}
