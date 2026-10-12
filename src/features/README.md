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

- **Features:** `sketch({ plane, profile, body? })`, `extrude({ sketch, distance, operation: "new" | "join" | "cut", target, extent: "distance" | "through" })`, `fillet({ body, edges, radius })`, `chamfer({ body, edges, distance })`. A feature's optional second argument is `{ name }`.
- **Profiles and planes:** `rect({ from, to })` (segments `front`, `right`, `back`, `left`), `circle({ center, radius, id = "c" })`, `polygon({ id: [x, y], … })`, `plane("XY" | "XZ" | "YZ", offset)`, or a face reference with the face's `body`.
- **References** ([research/03](../../research/03-topological-naming.md#references-in-code)): `extrude1.side.front`, `extrude1.start`, `extrude1.end`, `edge(a, b)`, `any(a, b)`, `.piece(op, k, { near })`, `fillet1.face(edge)`, `fillet1.corner`, and `ref.<name>` for features without a variable.

Entry points: `.` for models, `./schema` for the parameter schemas (no kernel code), `./runtime` for the editor (build trace, picking). `examples/` holds the benchmark parts M1 and M3. `pnpm test` reruns research/03's benchmark cells for them through the library and checks that the examples run as plain modules.
