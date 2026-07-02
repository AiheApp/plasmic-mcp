import { describe, it, expect } from "vitest";
import {
  buildTextNode,
  buildElement,
  buildPageComponent,
  buildCodeComponent,
} from "../src/model/index.js";

describe("builders", () => {
  it("buildTextNode: TplTag(type text) → VS → RS + RawText", () => {
    const { nodes, rootId } = buildTextNode("Hello", "baseVar1");
    const tpl = nodes[rootId] as { __type: string; type: string; vsettings: { __ref: string }[] };
    expect(tpl.__type).toBe("TplTag");
    expect(tpl.type).toBe("text");
    const vs = nodes[tpl.vsettings[0].__ref] as {
      variants: { __ref: string }[];
      text: { __ref: string } | null;
    };
    expect(vs.variants[0].__ref).toBe("baseVar1");
    expect(vs.text).not.toBeNull();
    const raw = nodes[vs.text!.__ref] as { __type: string; text: string };
    expect(raw.__type).toBe("RawText");
    expect(raw.text).toBe("Hello");
  });

  it("buildElement without text has a null vsetting.text", () => {
    const { nodes, rootId, rsId } = buildElement({
      tag: "div",
      type: "other",
      baseVariantIid: "bv",
    });
    const tpl = nodes[rootId] as { tag: string; vsettings: { __ref: string }[] };
    expect(tpl.tag).toBe("div");
    const vs = nodes[tpl.vsettings[0].__ref] as { text: unknown; rs: { __ref: string } };
    expect(vs.text).toBeNull();
    expect(vs.rs.__ref).toBe(rsId);
  });

  it("buildPageComponent: page + base variant + arena (empty grids)", () => {
    const frag = buildPageComponent("Home", "/home", "Hi");
    const comp = frag.nodes[frag.pageId] as {
      __type: string;
      type: string;
      variants: { __ref: string }[];
      pageMeta: { __ref: string };
    };
    expect(comp.__type).toBe("Component");
    expect(comp.type).toBe("page");
    expect(comp.variants[0].__ref).toBe(frag.baseVariantId);
    const pm = frag.nodes[comp.pageMeta.__ref] as { path: string };
    expect(pm.path).toBe("/home");
    const arena = frag.nodes[frag.arenaId] as {
      __type: string;
      matrix: { __ref: string };
      customMatrix: { __ref: string };
    };
    expect(arena.__type).toBe("PageArena");
    const grid = frag.nodes[arena.matrix.__ref] as { __type: string; rows: unknown[] };
    expect(grid.__type).toBe("ArenaFrameGrid");
    expect(grid.rows).toEqual([]);
    const custGrid = frag.nodes[arena.customMatrix.__ref] as { rows: unknown[] };
    expect(custGrid.rows).toEqual([]);
  });

  it("buildPageComponent without text: root has no children", () => {
    const frag = buildPageComponent("Blank", "/blank");
    const comp = frag.nodes[frag.pageId] as { tplTree: { __ref: string } };
    const root = frag.nodes[comp.tplTree.__ref] as { children: unknown[] };
    expect(root.children).toEqual([]);
  });

  it("buildCodeComponent: type code + codeComponentMeta.importPath", () => {
    const frag = buildCodeComponent("MyButton", "./MyButton");
    const comp = frag.nodes[frag.compId] as {
      type: string;
      codeComponentMeta: { __ref: string };
    };
    expect(comp.type).toBe("code");
    const ccm = frag.nodes[comp.codeComponentMeta.__ref] as {
      __type: string;
      importPath: string;
      importName: string;
    };
    expect(ccm.__type).toBe("CodeComponentMeta");
    expect(ccm.importPath).toBe("./MyButton");
    expect(ccm.importName).toBe("MyButton");
  });
});
