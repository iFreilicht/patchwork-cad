// Configurations in the model document (research/17-parameters.md): named sets of values, kept next
// to the code, renamed with a parameter, and values linked from other documents.
import { cursor, initSubduction, Repo, type AutomergeUrl, type DocHandle } from "@automerge/automerge-repo";
import { splice } from "@automerge/automerge";
import { beforeAll, expect, test } from "vitest";
import { resolvedFrom } from "../src/components/configurations.ts";
import { addConfiguration, configurations, isLinked, removeConfiguration, renameConfiguration, renameParamInConfigurations, setConfigurationValues } from "../src/model/configurations.ts";
import type { CadModelDoc } from "../src/types.ts";

beforeAll(() => initSubduction());

const model = (): DocHandle<CadModelDoc> => new Repo().create<CadModelDoc>({ title: "m", source: "" });

test("configurations are added, renamed, given values and removed", () => {
  const handle = model();
  handle.change((d) => addConfiguration(d, { id: "a", name: "Small", params: { w: 30, ribs: [10] } }));
  handle.change((d) => renameConfiguration(d, "a", "Tiny"));
  handle.change((d) => setConfigurationValues(d, "a", { w: 20, d: { link: "automerge:abc/rows/@0/width" as AutomergeUrl }, ribs: undefined }));
  expect(configurations(handle.doc())).toEqual([{ id: "a", name: "Tiny", params: { w: 20, d: { link: "automerge:abc/rows/@0/width" } } }]);
  expect(isLinked(configurations(handle.doc())[0]?.params["d"])).toBe(true);
  expect(isLinked(configurations(handle.doc())[0]?.params["w"])).toBe(false);
  handle.change((d) => removeConfiguration(d, "a"));
  expect(configurations(handle.doc())).toEqual([]);
});

test("renaming a parameter moves its values in every configuration", () => {
  const handle = model();
  handle.change((d) => addConfiguration(d, { id: "a", name: "A", params: { w: 1, h: 2 } }));
  handle.change((d) => addConfiguration(d, { id: "b", name: "B", params: { h: 3 } }));
  handle.change((d) => renameParamInConfigurations(d, "w", "width"));
  expect(configurations(handle.doc()).map((c) => c.params)).toEqual([{ h: 2, width: 1 }, { h: 3 }]);
});

test("a linked value is a number, or numeric text, else it says why not", () => {
  expect(resolvedFrom(42)).toEqual({ value: 42 });
  expect(resolvedFrom(" -1.5 ")).toEqual({ value: -1.5 });
  expect(resolvedFrom("12 mm").problem).toMatch(/not a number/);
  expect(resolvedFrom("").problem).toMatch(/deleted/);
  expect(resolvedFrom(undefined).problem).toMatch(/isn't there/);
});

test("a link into a field follows it; a link into text breaks when its number is typed anew", async () => {
  const repo = new Repo();
  const sheet = repo.create<{ rows: { width: number }[]; note: string }>({ rows: [{ width: 7 }], note: "width is 42 mm" });
  const field = await repo.find(sheet.sub("rows", 0, "width").url);
  const text = await repo.find(sheet.sub("note", cursor(9, 11)).url);
  expect([resolvedFrom(field.doc()), resolvedFrom(text.doc())]).toEqual([{ value: 7 }, { value: 42 }]);
  sheet.change((d) => {
    d.rows[0]!.width = 9;
    splice(d, ["note"], 9, 2, "45");
  });
  expect(resolvedFrom(field.doc())).toEqual({ value: 9 });
  // The range's characters are gone: the cursor collapses (research/13, "Anchors under edits").
  expect(resolvedFrom(text.doc()).problem).toMatch(/deleted/);
});
