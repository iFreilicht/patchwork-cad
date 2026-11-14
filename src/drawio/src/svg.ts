/**
 * A diagram as a .drawio.svg file: an SVG of the diagram that carries the diagram itself, draw.io's
 * `mxfile` XML, in its root's `content` attribute, as draw.io's "SVG with embedded XML" export
 * (`xmlsvg`) writes it. Any viewer shows the picture; draw.io opens the diagram.
 */

/** A diagram without cells, as draw.io starts one. */
export const EMPTY_DIAGRAM = '<mxfile><diagram id="page-1" name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unescape = (text: string) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#10;/g, "\n").replace(/&amp;/g, "&");

/** An SVG of nothing that carries `diagram`, for a new document. */
export const emptySvg = (diagram = EMPTY_DIAGRAM) => `<svg xmlns="http://www.w3.org/2000/svg" width="1px" height="1px" viewBox="-0.5 -0.5 1 1" content="${escape(diagram)}"></svg>`;

/** The diagram a .drawio.svg carries, from its root's `content` attribute; undefined for an SVG that carries none. */
export function diagramOf(svg: string): string | undefined {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0];
  const content = root && /\scontent\s*=\s*("([^"]*)"|'([^']*)')/i.exec(root);
  const value = content ? (content[2] ?? content[3]) : undefined;
  return value ? unescape(value) : undefined;
}

/** The text of a data URI, as draw.io's export gives it: base64 or percent-encoded, UTF-8. */
export function textOfDataUri(uri: string): string {
  const comma = uri.indexOf(",");
  const header = uri.slice(0, comma);
  const body = uri.slice(comma + 1);
  if (!header.endsWith(";base64")) return decodeURIComponent(body);
  const binary = atob(body);
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}
