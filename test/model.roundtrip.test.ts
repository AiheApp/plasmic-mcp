import { describe, it, expect } from "vitest";
import {
  buildPageComponent,
  mergeFragment,
  serializeModel,
  parseModel,
  findPageByPath,
  buildRevisionBody,
  getNode,
  type ModelNode,
  type Ref,
} from "../src/model/index.js";
import { emptySite, assertNoOrphanRefs } from "./fixtures/site.js";
import { arenaContextOf } from "../src/model/index.js";

describe("round-trip: build → merge → serialize → reparse → find", () => {
  it("finds the page after a full serialize/parse cycle, graph stays valid", () => {
    const model = emptySite();
    const frag = buildPageComponent("Landing", "/landing", "Welcome", arenaContextOf(model));
    const { idMap } = mergeFragment(model, frag);
    const pageIid = idMap[frag.pageId];
    const arenaIid = idMap[frag.arenaId];
    const site = model.map[model.root] as ModelNode & {
      components: Ref[];
      pageArenas: Ref[];
    };
    site.components.push({ __ref: pageIid });
    site.pageArenas.push({ __ref: arenaIid });

    // inv5: both container arrays gained a ref, kept in sync.
    expect(site.components.some((r) => r.__ref === pageIid)).toBe(true);
    expect(site.pageArenas.some((r) => r.__ref === arenaIid)).toBe(true);

    const serialized = serializeModel(model);
    expect(typeof serialized).toBe("string");
    const reparsed = parseModel(serialized);

    expect(reparsed.root).toBe(model.root);
    expect(findPageByPath(reparsed, "/landing")).toBe(pageIid);
    assertNoOrphanRefs(reparsed);

    // The page's tplTree + base variant survive the round trip.
    const comp = getNode(reparsed, pageIid) as ModelNode & {
      tplTree: Ref;
      variants: Ref[];
    };
    expect(reparsed.map[comp.tplTree.__ref].__type).toBe("TplTag");
    expect(reparsed.map[comp.variants[0].__ref].__type).toBe("Variant");
  });

  it("inv7: buildRevisionBody sets revisionNum = currentRevision + 1", () => {
    const model = emptySite();
    const body = buildRevisionBody(model, 41, ["comp1"]);
    expect(body.revisionNum).toBe(42);
    expect(body.modifiedComponentIids).toEqual(["comp1"]);
    expect(body.modelSchemaHash).toBe(-516264365);
    expect(body.modelVersion).toBe(21);
    expect(body.incremental).toBe(false);
    expect(body.branchId).toBeNull();
    expect(JSON.parse(body.data).root).toBe(model.root);
  });

  it("parseModel rejects a non-bundle", () => {
    expect(() => parseModel(JSON.stringify({ nope: true }))).toThrow();
  });
});
