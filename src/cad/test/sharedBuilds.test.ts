import { expect, test } from "vitest";
import { paramsKey, shareBuilds, sharedBuild, type SharedBuild } from "../src/components/sharedBuilds.ts";

const build = (source: string, params = "", imports = ""): SharedBuild => ({
  source,
  params,
  imports,
  result: { ok: true, source, params: undefined, imports: {}, paramValues: { defaults: {}, given: {} }, shapes: [], sketches: [], dropped: 0, trace: [], timings: { build: 0, total: 0 } } as unknown as SharedBuild["result"],
  locate: async () => [],
});

test("a build shown in the page is taken when it was built from the same source, parameters and imports", async () => {
  let building = false;
  const editor = shareBuilds("automerge:model", () => building);
  editor.show(build("a", paramsKey({ h: 8 }), "docs@1"));
  expect((await sharedBuild("automerge:model", "a", paramsKey({ h: 8 }), "docs@1"))?.source).toBe("a");
  // Another source, other parameters, other versions of the documents it imports: built again.
  expect(await sharedBuild("automerge:model", "b", paramsKey({ h: 8 }), "docs@1")).toBeUndefined();
  expect(await sharedBuild("automerge:model", "a", paramsKey({ h: 30 }), "docs@1")).toBeUndefined();
  expect(await sharedBuild("automerge:model", "a", paramsKey({ h: 8 }), "docs@2")).toBeUndefined();
  // Nothing shown of another model.
  expect(await sharedBuild("automerge:other", "a", paramsKey({ h: 8 }), "docs@1")).toBeUndefined();

  // While it builds, the build it is about to show is waited for.
  building = true;
  const waited = sharedBuild("automerge:model", "c", "", "");
  setTimeout(() => {
    editor.show(build("c"));
    building = false;
  }, 250);
  expect((await waited)?.source).toBe("c");

  editor.stop();
  expect(await sharedBuild("automerge:model", "c", "", "")).toBeUndefined();
});

test("parameters are the same whichever order their keys are in", () => {
  expect(paramsKey({ a: 1, b: 2 })).toBe(paramsKey({ b: 2, a: 1 }));
  expect(paramsKey(undefined)).toBe("");
});
