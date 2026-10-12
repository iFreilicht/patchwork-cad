// Parsed in a worker by the host: metadata and lazy load()s only (see the
// writing-patchwork-tools skill, section 2).
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
    name: "CAD Model",
    icon: "Box",
    supportedDatatypes: ["cad-model"],
    async load() {
      return (await import("./tool.tsx")).default;
    },
  },
];
