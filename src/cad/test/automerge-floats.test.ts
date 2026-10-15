// Canary for the rounding in Viewer.tsx's cameraState: when this fails, Automerge stores lists' floats intact and the rounding can go.
import * as A from "@automerge/automerge";
import { expect, test } from "vitest";

test("Automerge 3.4.1 stores 0.9999999999999999 in a list as 0, but not in a map", () => {
  const doc = A.change(A.from<{ list?: number[]; value?: number }>({}), (d) => {
    d.list = [0.9999999999999999, 1.9999999999999998];
    d.value = 0.9999999999999999;
  });
  expect(doc.list).toEqual([0, 1.9999999999999998]);
  expect(doc.value).toBe(0.9999999999999999);
});
