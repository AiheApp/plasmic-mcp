import { describe, it, expect } from "vitest";
import {
  insertNode,
  deleteNode,
  updateRuleSet,
  findNodesByType,
  findPageByPath,
  ownerComponentOf,
  collectDescendants,
  getNode,
  deref,
  buildElement,
  mergeFragment,
  type ModelNode,
  type Ref,
} from "../src/model/index.js";
import { siteWithPage, assertNoOrphanRefs } from "./fixtures/site.js";

describe("graph mutations + invariants", () => {
  it("inv1/inv2: insertNode wires parent child ref + Tpl.parent + uuid", () => {
    const { model, rootTplIid } = siteWithPage();
    const node: ModelNode = {
      __type: "TplTag",
      tag: "div",
      name: null,
      children: [],
      type: "other",
      codeGenType: null,
      columnsSetting: null,
      uuid: "TEMP",
      parent: null,
      locked: null,
      vsettings: [],
    };
    const iid = insertNode(model, node, rootTplIid);

    const parent = getNode(model, rootTplIid) as ModelNode & { children: Ref[] };
    expect(parent.children.some((r) => r.__ref === iid)).toBe(true); // inv1
    expect((getNode(model, iid) as { parent: Ref }).parent).toEqual({
      __ref: rootTplIid,
    }); // inv2
    expect((getNode(model, iid) as { uuid: string }).uuid).toBe(iid);
  });

  it("inv1: mergeFragment wires the fragment root under the parent", () => {
    const { model, rootTplIid, baseVariantIid } = siteWithPage();
    const frag = buildElement({
      tag: "span",
      type: "other",
      baseVariantIid,
      text: "hi",
    });
    const { rootIid } = mergeFragment(model, frag, rootTplIid);
    const parent = getNode(model, rootTplIid) as ModelNode & { children: Ref[] };
    expect(parent.children.some((r) => r.__ref === rootIid)).toBe(true);
    expect((getNode(model, rootIid) as { parent: Ref }).parent).toEqual({
      __ref: rootTplIid,
    });
    assertNoOrphanRefs(model);
  });

  it("inv3: every page Component has >=1 base Variant", () => {
    const { model, pageIid } = siteWithPage();
    const comp = getNode(model, pageIid) as ModelNode & { variants: Ref[] };
    expect(comp.variants.length).toBeGreaterThanOrEqual(1);
    for (const v of comp.variants) {
      expect(getNode(model, v.__ref).__type).toBe("Variant");
    }
  });

  it("inv4: every VariantSetting.variants ref resolves to a Variant", () => {
    const { model } = siteWithPage();
    const vsIids = findNodesByType(model, "VariantSetting");
    expect(vsIids.length).toBeGreaterThan(0);
    for (const iid of vsIids) {
      const vs = getNode(model, iid) as ModelNode & { variants: Ref[] };
      for (const ref of vs.variants) {
        expect(getNode(model, ref.__ref).__type).toBe("Variant");
      }
    }
  });

  it("deleteNode: removes descendants + strips parent ref, no orphans", () => {
    const { model, rootTplIid } = siteWithPage("Home", "/", "Hello");
    const root = getNode(model, rootTplIid) as ModelNode & { children: Ref[] };
    const textTplIid = root.children[0].__ref;
    const doomed = [textTplIid, ...collectDescendants(model, textTplIid)];
    expect(doomed.length).toBeGreaterThan(1); // tpl + vs + rs + rawtext

    deleteNode(model, textTplIid);

    for (const iid of doomed) expect(iid in model.map).toBe(false);
    const rootAfter = getNode(model, rootTplIid) as ModelNode & {
      children: Ref[];
    };
    expect(rootAfter.children.some((r) => r.__ref === textTplIid)).toBe(false);
    assertNoOrphanRefs(model);
  });

  it("updateRuleSet: sets props, and null deletes them", () => {
    const { model } = siteWithPage();
    const rsIid = findNodesByType(model, "RuleSet")[0];
    updateRuleSet(model, rsIid, { color: "red", padding: "4px" });
    let rs = getNode(model, rsIid) as ModelNode & {
      values: Record<string, string>;
    };
    expect(rs.values.color).toBe("red");
    expect(rs.values.padding).toBe("4px");
    updateRuleSet(model, rsIid, { color: null });
    rs = getNode(model, rsIid) as ModelNode & { values: Record<string, string> };
    expect("color" in rs.values).toBe(false);
    expect(rs.values.padding).toBe("4px");
  });

  it("findPageByPath / findNodesByType locate the page", () => {
    const { model, pageIid } = siteWithPage("About", "/about", undefined);
    expect(findPageByPath(model, "/about")).toBe(pageIid);
    expect(findPageByPath(model, "/missing")).toBeNull();
    expect(findNodesByType(model, "PageArena").length).toBe(1);
  });

  it("ownerComponentOf resolves component from tpl / vs / rs / rawtext", () => {
    const { model, pageIid, rootTplIid } = siteWithPage("Home", "/", "Hello");
    expect(ownerComponentOf(model, rootTplIid)).toBe(pageIid);
    const rsIid = findNodesByType(model, "RuleSet")[0];
    expect(ownerComponentOf(model, rsIid)).toBe(pageIid);
    const rawIid = findNodesByType(model, "RawText")[0];
    expect(ownerComponentOf(model, rawIid)).toBe(pageIid);
    const vsIid = findNodesByType(model, "VariantSetting")[0];
    expect(ownerComponentOf(model, vsIid)).toBe(pageIid);
  });

  it("allocated iids are unique 12-char lowercase-alphanumeric", () => {
    const { model } = siteWithPage();
    const keys = Object.keys(model.map).filter((k) => k !== model.root);
    for (const k of keys) expect(k).toMatch(/^[a-z0-9]{12}$/);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("deref returns null for null refs", () => {
    const { model } = siteWithPage();
    expect(deref(model, null)).toBeNull();
  });
});
