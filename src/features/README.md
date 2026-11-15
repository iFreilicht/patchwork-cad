# @patchwork-cad/features

The feature library that CAD models import: the thin library of [research/02](../../research/02-model-storage.md#design-goal-portable-models), with the subset of [research/07](../../research/07-poc-modelling-ui.md). A model runs with replicad, OCCT and this library alone; the library uses the OCCT instance given to replicad's `setOC`.

```js
import { sketch, plane, rect, circle, extrude, fillet, edge } from "@patchwork-cad/features";

export default function main() {
  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [60, 40] }) });
  const plate = extrude({ sketch: sketch1, distance: 12 });
  const sketch2 = sketch({ plane: plane("XY"), profile: circle({ center: [30, 20], radius: 4 }) });
  const bore = extrude({ sketch: sketch2, operation: "cut", target: plate, extent: "through" });
  return fillet({ body: bore, edges: [edge(plate.end, bore.side.c)], radius: 1.5 });
}
```

- **Features:** `sketch({ plane, profile, body? })`, `extrude({ sketch, regions?, distance, operation: "new" | "join" | "cut", target, extent: "distance" | "through" })`, whose distance runs along the sketch's normal for every operation, so that a cut into the body a sketch lies on is negative, as in Fusion, `fillet({ body, edges, radius })`, `chamfer({ body, edges, distance })`. A feature's optional second argument is `{ name }`.
- **Regions** ([research/21](../../research/21-embedding.md#sketch-from-a-drawing)): a sketch's curves split its plane, and every part bounded on all sides is a region, as Fusion's profiles: two overlapping rectangles enclose three, a curve that doesn't close encloses nothing unless others close it. `sketch2.region("a", "b")` is the region inside the closed paths `a` and `b` and no other, `sketch2.region("a", { near: [x, y] })` the one at that point of several such, `sketch2.filled` all that a fill covers. `extrude`'s `regions` takes one or a list, joined where they touch; a sketch with one region needs none. Side faces are named by segment ids; a segment or cap that gives several faces names pieces (`extrude1.side["a.2"].piece(extrude1, 1)`).
- **Profiles and planes:** `rect({ from, to })` (segments `front`, `right`, `back`, `left`), `circle({ center, radius, id = "c" })`, `polygon({ id: [x, y], … })`, `plane("XY" | "XZ" | "YZ", offset)`, or a face reference with the face's `body`.
- **Drawings** ([research/21](../../research/21-embedding.md#sketch-from-a-drawing)): `svg(text, { width | height | scale, center, only, fonts })` is a profile of an SVG's paths, shapes (`rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`), `use`s and texts, with their transforms, nested viewports, style sheets with simple selectors, and fills, parsed without a DOM. Its y axis points up, the middle of what it draws lies at `center`, and a drawing sized in absolute units keeps its size, a pixel counting as a millimetre otherwise. An element's loops are named by its `id` (or draw.io's `data-cell-id`), else by tag and number within the nearest element that has one (`marks/rect2`), with `.2` for its second subpath; segments are numbered (`leaf.3`). What isn't shown isn't drawn; what can't be drawn (images, HTML, clip paths, text on a path, an unknown font) is a warning of its sketch, and an unreadable file fails the sketch. Texts are drawn in fonts registered with `registerFont(bytes)` or given by family in `fonts`; a family that isn't there is drawn in another, as browsers do, and said so. The editor registers Liberation Sans, Serif and Mono (devshell `CAD_FONTS`), which have the metrics of Arial, Times New Roman and Courier New.
- **References** ([research/03](../../research/03-topological-naming.md#references-in-code)): `extrude1.side.front`, `extrude1.start`, `extrude1.end`, `edge(a, b)`, `any(a, b)`, `.piece(op, k, { near })`, `fillet1.face(edge)`, `fillet1.corner`, and `ref.<name>` for features without a variable.

Entry points: `.` for models, `./schema` for the parameter schemas (no kernel code), `./runtime` for the editor (build trace, picking). `examples/` holds the benchmark parts M1 and M3. `pnpm test` reruns research/03's benchmark cells for them through the library and checks that the examples run as plain modules.
