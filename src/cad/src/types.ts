export interface CadModelDoc {
  title: string;
  /** The model: a plain ES module that imports replicad and default-exports a function returning shapes. */
  source: string;
}
