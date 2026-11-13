// A view of PB's tldraw5 documents for canvases in a CAD model (research/22-document-canvases.md).
export const plugins = [
  {
    type: "patchwork:tool",
    id: "tldraw-canvas-view",
    name: "tldraw (canvas view)",
    supportedDatatypes: ["tldraw5"],
    // Only for hosts that ask for it by id, e.g. a CAD model's canvases.
    unlisted: true,
    async load() {
      return (await import("./tool.tsx")).default;
    },
  },
];
