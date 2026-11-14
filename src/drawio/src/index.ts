// Parsed in a worker by the host: metadata and lazy load()s only (see the writing-patchwork-tools
// skill). A draw.io diagram, kept as a .drawio.svg file, and its editor.
export const plugins = [
  {
    type: "patchwork:datatype",
    id: "drawio",
    name: "draw.io Diagram",
    icon: "Workflow",
    async load() {
      return (await import("./datatype.ts")).DrawioDatatype;
    },
  },
  {
    type: "patchwork:tool",
    id: "drawio",
    name: "draw.io",
    icon: "Workflow",
    supportedDatatypes: ["drawio"],
    async load() {
      return (await import("./tool.ts")).default;
    },
  },
];
