// Parsed in a worker by the host: metadata and lazy load()s only (see the
// writing-patchwork-tools skill, section 2). One datatype, two tools that
// share components. Patchwork opens a datatype's first listed tool by id
// (getFallbackTool), so the WYSIWYG editor has the shortest id.
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
    supportedDatatypes: ["cad-model"],
    async load() {
      return (await import("./tools/viewer.tsx")).default;
    },
  },
];
