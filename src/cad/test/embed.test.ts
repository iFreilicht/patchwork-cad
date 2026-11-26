// The `@patchwork` metadata of embeds the editor creates: the package to load for someone without it.
import { encodeHeads, parseAutomergeUrl, stringifyAutomergeUrl, type AutomergeUrl } from "@automerge/automerge-repo";
import { expect, test } from "vitest";
import { patchworkMetadata } from "../src/components/embed.ts";

const PACKAGE = "automerge:2owYJFe8TQ9krQHCDVJgKfVXggLG" as AutomergeUrl;

test("an HTTP package is suggested as it is", () => {
  expect(patchworkMetadata("cad-model-embed", "http://localhost:4173/packages/cad/")).toEqual({ type: "cad-model-embed", suggestedImportUrl: "http://localhost:4173/packages/cad/" });
});

test("a pinned package is suggested without its heads, and frozen with them", () => {
  const pinned = stringifyAutomergeUrl({ documentId: parseAutomergeUrl(PACKAGE).documentId, heads: encodeHeads(["a".repeat(64)]) });
  expect(patchworkMetadata("cad-model-embed", pinned)).toEqual({ type: "cad-model-embed", suggestedImportUrl: PACKAGE, frozenImportUrl: pinned });
});

test("without a registered package, only the type", () => {
  expect(patchworkMetadata("cad-model-embed")).toEqual({ type: "cad-model-embed" });
});
