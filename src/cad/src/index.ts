// Parsed in a worker by the host: metadata and lazy load()s only (see the
// writing-patchwork-tools skill, section 2). Two datatypes, a model and an
// embed of one, and two tools that share components. Patchwork opens a
// datatype's first listed tool by id (getFallbackTool), so the WYSIWYG
// editor has the shortest id.
export const plugins = [
  {
    type: "patchwork:datatype",
    id: "cad-model",
    name: "CAD Model",
    icon: "Box",
    async load() {
      return (await import("./datatype.ts")).CadModelDatatype;
    },
  },
  {
    type: "patchwork:datatype",
    id: "cad-model-embed",
    name: "CAD Embed",
    icon: "Camera",
    unlisted: true,
    async load() {
      return (await import("./embedDatatype.ts")).CadModelEmbedDatatype;
    },
  },
  {
    type: "patchwork:tool",
    id: "cad-model",
    name: "CAD Editor",
    icon: "Box",
    supportedDatatypes: ["cad-model"],
    async load() {
      return (await import("./tools/editor.tsx")).default;
    },
  },
  {
    type: "patchwork:tool",
    id: "cad-model-viewer",
    name: "CAD Viewer",
    icon: "Rotate3d",
    supportedDatatypes: ["cad-model", "cad-model-embed"],
    async load() {
      return (await import("./tools/viewer.tsx")).default;
    },
  },
  // A model placed in a scene (patchwork-experiments/scene, README "Writing a provider"): built at its
  // default parameters into a GLB, which the scene keeps in a render doc and builds again on a change.
  {
    type: "scene:source",
    id: "cad-model-scene",
    name: "CAD Model",
    icon: "Box",
    supportedDatatypes: ["cad-model"],
    content: "built",
    cost: "expensive",
    params: [],
    // Bump when build() makes different output from the same model.
    version: 1,
    async load() {
      return (await import("./scene/source.ts")).default;
    },
  },
  // Editing a model where it stands in a scene: its editor over the scene's view, its live build in
  // the object's place (src/scene/editTool.tsx).
  {
    type: "scene:view",
    id: "cad-model-scene-edit",
    name: "CAD model editing",
    async load() {
      return (await import("./scene/editTool.tsx")).default;
    },
  },
];
