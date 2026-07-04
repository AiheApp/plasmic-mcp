import { describe, it, expect } from "vitest";
import {
  buildTextNode,
  buildElement,
  buildPageComponent,
  buildPageArena,
  buildCodeComponent,
  type ArenaContext,
} from "../src/model/index.js";

/** Arena context as a live model would provide (Studio's default sizes). */
const testArenaCtx = (): ArenaContext => ({
  globalVariantIid: "globalVar1",
  screenSizes: [
    { width: 1366, height: 768 },
    { width: 414, height: 736 },
  ],
});

/** Assert one healthy arena shape (ground truth: Studio-UI-created page). */
function expectHealthyArena(
  nodes: Record<string, unknown>,
  arenaId: string,
  pageRef: string,
  baseVariantRef: string,
  ctx: ArenaContext
) {
  const node = (id: string) => nodes[id] as Record<string, never>;
  const arena = node(arenaId) as {
    __type: string;
    component: { __ref: string };
    matrix: { __ref: string };
    customMatrix: { __ref: string };
  };
  expect(arena.__type).toBe("PageArena");
  expect(arena.component.__ref).toBe(pageRef);

  const grid = node(arena.matrix.__ref) as { __type: string; rows: { __ref: string }[] };
  expect(grid.__type).toBe("ArenaFrameGrid");
  expect(grid.rows).toHaveLength(1);

  const row = node(grid.rows[0].__ref) as {
    __type: string;
    rowKey: { __ref: string };
    cols: { __ref: string }[];
  };
  expect(row.__type).toBe("ArenaFrameRow");
  expect(row.rowKey.__ref).toBe(baseVariantRef);
  expect(row.cols).toHaveLength(ctx.screenSizes.length);

  row.cols.forEach((cellRef, i) => {
    const cell = node(cellRef.__ref) as {
      __type: string;
      cellKey: null;
      frame: { __ref: string };
    };
    expect(cell.__type).toBe("ArenaFrameCell");
    expect(cell.cellKey).toBeNull();
    const frame = node(cell.frame.__ref) as {
      __type: string;
      width: number;
      height: number;
      viewMode: string;
      lang: string;
      targetVariants: { __ref: string }[];
      container: { __ref: string };
    };
    expect(frame.__type).toBe("ArenaFrame");
    expect(frame.width).toBe(ctx.screenSizes[i].width);
    expect(frame.height).toBe(ctx.screenSizes[i].height);
    expect(frame.viewMode).toBe("stretch");
    expect(frame.lang).toBe("English");
    expect(frame.targetVariants.map((r) => r.__ref)).toEqual([baseVariantRef]);
    const cont = node(frame.container.__ref) as {
      __type: string;
      component: { __ref: string };
      vsettings: { __ref: string }[];
    };
    expect(cont.__type).toBe("TplComponent");
    expect(cont.component.__ref).toBe(pageRef);
    const vs = node(cont.vsettings[0].__ref) as {
      __type: string;
      variants: { __ref: string }[];
    };
    expect(vs.__type).toBe("VariantSetting");
    expect(vs.variants.map((r) => r.__ref)).toEqual([ctx.globalVariantIid]);
  });

  // customMatrix: exactly ONE row with rowKey null and no cols (fresh page
  // has no variant combos) — NOT zero rows.
  const custGrid = node(arena.customMatrix.__ref) as { rows: { __ref: string }[] };
  expect(custGrid.rows).toHaveLength(1);
  const custRow = node(custGrid.rows[0].__ref) as { rowKey: null; cols: unknown[] };
  expect(custRow.rowKey).toBeNull();
  expect(custRow.cols).toEqual([]);
}

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

  it("buildPageComponent: page + base variant + a HEALTHY arena (one frame per screen size)", () => {
    const ctx = testArenaCtx();
    const frag = buildPageComponent("Home", "/home", "Hi", ctx);
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
    expectHealthyArena(
      frag.nodes,
      frag.arenaId,
      frag.pageId,
      frag.baseVariantId,
      ctx
    );
  });

  it("buildPageArena: standalone arena for an existing page (real iids pass through)", () => {
    const ctx = testArenaCtx();
    const frag = buildPageArena("existingPage", "existingBaseVar", ctx);
    expect(frag.rootId).toBe(frag.arenaId);
    expectHealthyArena(frag.nodes, frag.arenaId, "existingPage", "existingBaseVar", ctx);
    // The referenced page/variant are NOT part of the fragment.
    expect(frag.nodes["existingPage"]).toBeUndefined();
    expect(frag.nodes["existingBaseVar"]).toBeUndefined();
  });

  it("buildPageComponent without text: root has no children", () => {
    const frag = buildPageComponent("Blank", "/blank", undefined, testArenaCtx());
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
