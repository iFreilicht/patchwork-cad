// A second tool for PB's tldraw5 documents (research/16-undo-redo.md, "tldraw").
export const plugins = [
  {
    type: "patchwork:tool",
    id: "tldraw-doc-undo",
    name: "tldraw (document undo)",
    supportedDatatypes: ["tldraw5"],
    async load() {
      return (await import("./tool.tsx")).default;
    },
  },
];
