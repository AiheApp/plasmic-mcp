import { describe, it, expect } from "vitest";
import {
  BatchOpError,
  executeOps,
  findNodesByType,
  findPageByPath,
  prevalidateOps,
  resolveToken,
  tokenRefValue,
  type BatchContext,
  type ModelNode,
  type MutationOp,
  type Ref,
} from "../src/model/index.js";
import { assertNoOrphanRefs, emptySite, siteWithPage } from "./fixtures/site.js";

const TOKENS: BatchContext["tokens"] = [
  { uuid: "tokPrimary1", name: "primary-blue", type: "Color", value: "#4169e1" },
  { uuid: "tokText1", name: "text-light-1", type: "Color", value: "#1f1f1f" },
  { uuid: "tokFontLg1", name: "font-size-lg", type: "FontSize", value: "16px" },
];
const ctx: BatchContext = { tokens: TOKENS };

function expectBatchError(fn: () => unknown, code: string): BatchOpError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BatchOpError);
    const err = e as BatchOpError;
    expect(err.detail.code).toBe(code);
    return err;
  }
  throw new Error(`expected BatchOpError ${code}, but nothing was thrown`);
}

describe("executeOps", () => {
  it("create_page + add_element via $ref + apply_token via $id.rs, atomically in memory", () => {
    const model = emptySite();
    const ops: MutationOp[] = [
      { op: "create_page", id: "pg", name: "Pricing", path: "/pricing" },
      {
        op: "add_element",
        id: "h1",
        parentIid: "$pg.rootTpl",
        tag: "div",
        type: "text",
        text: "Simple pricing",
      },
      { op: "apply_token", rsIid: "$h1.rs", prop: "color", token: "primary-blue" },
    ];
    const { changes, modifiedComponentIids, env } = executeOps(model, ops, ctx);

    assertNoOrphanRefs(model);
    expect(changes).toHaveLength(3);
    const pageIid = env.pg.iid;
    expect(findPageByPath(model, "/pricing")).toBe(pageIid);
    // the new element carries the text and the token var
    const raw = findNodesByType(model, "RawText").map(
      (iid) => (model.map[iid] as { text: string }).text
    );
    expect(raw).toContain("Simple pricing");
    const rs = model.map[env.h1.rs] as ModelNode & { values: Record<string, string> };
    expect(rs.values.color).toBe(tokenRefValue("tokPrimary1"));
    // both ops belong to the same new page component
    expect(modifiedComponentIids).toEqual([pageIid]);
    // element landed under the page root
    const rootTpl = model.map[env.pg.rootTpl] as ModelNode & { children: Ref[] };
    expect(rootTpl.children.some((r) => r.__ref === env.h1.iid)).toBe(true);
  });

  it("throws UNKNOWN_REF for forward references and unknown ids/fields", () => {
    expectBatchError(
      () =>
        executeOps(
          emptySite(),
          [
            {
              op: "add_element",
              parentIid: "$later",
              tag: "div",
              type: "other",
            },
            { op: "create_page", id: "later", name: "P", path: "/p" },
          ],
          ctx
        ),
      "UNKNOWN_REF"
    );

    const { model } = siteWithPage();
    expectBatchError(
      () =>
        executeOps(
          model,
          [
            { op: "create_page", id: "pg", name: "P", path: "/p" },
            {
              op: "add_element",
              parentIid: "$pg.nope",
              tag: "div",
              type: "other",
            },
          ],
          ctx
        ),
      "UNKNOWN_REF"
    );
  });

  it("delete_element then targeting inside the deleted subtree fails with TARGET_NOT_FOUND", () => {
    const { model, rootTplIid } = siteWithPage("Home", "/", "Hello");
    const textTplIid = (model.map[rootTplIid] as ModelNode & { children: Ref[] })
      .children[0].__ref;
    const err = expectBatchError(
      () =>
        executeOps(
          model,
          [
            { op: "delete_element", iid: textTplIid },
            { op: "delete_element", iid: textTplIid },
          ],
          ctx
        ),
      "TARGET_NOT_FOUND"
    );
    expect(err.detail.opIndex).toBe(1);
  });

  it("delete_element refuses non-Tpl targets", () => {
    const { model, pageIid } = siteWithPage();
    expectBatchError(
      () => executeOps(model, [{ op: "delete_element", iid: pageIid }], ctx),
      "INVALID_TARGET"
    );
  });

  it("create_page onto an existing path fails with PATH_TAKEN", () => {
    const { model } = siteWithPage("Home", "/");
    expectBatchError(
      () =>
        executeOps(model, [{ op: "create_page", name: "Home2", path: "/" }], ctx),
      "PATH_TAKEN"
    );
  });

  it("set_text by path updates all RawText; by textIid only one", () => {
    const { model, rootTplIid, baseVariantIid, pageIid } = siteWithPage(
      "Home",
      "/",
      "Hello"
    );
    // add a second text element so "all" vs "one" differ
    executeOps(
      model,
      [
        {
          op: "add_element",
          parentIid: rootTplIid,
          tag: "div",
          type: "text",
          text: "Second",
          baseVariantIid,
        },
      ],
      ctx
    );
    const all = executeOps(
      model,
      [{ op: "set_text", path: "/", text: "Same" }],
      ctx
    );
    expect(all.modifiedComponentIids).toEqual([pageIid]);
    const rawIids = findNodesByType(model, "RawText");
    expect(
      rawIids.map((iid) => (model.map[iid] as { text: string }).text)
    ).toEqual(["Same", "Same"]);

    executeOps(
      model,
      [{ op: "set_text", path: "/", textIid: rawIids[0], text: "Solo" }],
      ctx
    );
    const texts = rawIids.map((iid) => (model.map[iid] as { text: string }).text);
    expect(texts.filter((t) => t === "Solo")).toHaveLength(1);
    expect(texts.filter((t) => t === "Same")).toHaveLength(1);
  });

  it("duplicate_page by sourcePath clones the page under the new path", () => {
    const { model, pageIid } = siteWithPage("Home", "/", "Hello");
    const { env } = executeOps(
      model,
      [
        {
          op: "duplicate_page",
          id: "copy",
          sourcePath: "/",
          name: "Home V2",
          path: "/home-v2",
        },
      ],
      ctx
    );
    assertNoOrphanRefs(model);
    expect(env.copy.iid).not.toBe(pageIid);
    expect(findPageByPath(model, "/home-v2")).toBe(env.copy.iid);
    expect(findNodesByType(model, "PageArena")).toHaveLength(2);
  });

  it("set_styles merges values and null-deletes properties", () => {
    const { model } = siteWithPage();
    const rsIid = findNodesByType(model, "RuleSet")[0];
    executeOps(
      model,
      [
        {
          op: "set_styles",
          rsIid,
          styles: { display: "flex", "flex-direction": "column" },
        },
      ],
      ctx
    );
    let values = (model.map[rsIid] as { values: Record<string, string> }).values;
    expect(values.display).toBe("flex");
    executeOps(
      model,
      [{ op: "set_styles", rsIid, styles: { display: null } }],
      ctx
    );
    values = (model.map[rsIid] as { values: Record<string, string> }).values;
    expect("display" in values).toBe(false);
    expect(values["flex-direction"]).toBe("column");
  });

  it("modifiedComponentIids dedupes across ops touching the same page", () => {
    const { model, rootTplIid, pageIid, baseVariantIid } = siteWithPage(
      "Home",
      "/",
      "Hello"
    );
    const { modifiedComponentIids } = executeOps(
      model,
      [
        {
          op: "add_element",
          parentIid: rootTplIid,
          tag: "div",
          type: "other",
          baseVariantIid,
        },
        { op: "set_text", path: "/", text: "New" },
      ],
      ctx
    );
    expect(modifiedComponentIids).toEqual([pageIid]);
  });
});

describe("prevalidateOps", () => {
  it("reports multiple independent errors in one pass without mutating", () => {
    const { model } = siteWithPage("Home", "/");
    const before = JSON.stringify(model);
    const errors = prevalidateOps(
      model,
      [
        { op: "delete_element", iid: "doesnotexist1" },
        { op: "apply_token", rsIid: "doesnotexist2", prop: "color", token: "primary-blu" },
        { op: "create_page", name: "Home2", path: "/" },
      ],
      ctx
    );
    expect(JSON.stringify(model)).toBe(before);
    const codes = errors.map((e) => e.code).sort();
    expect(codes).toEqual([
      "PATH_TAKEN",
      "TARGET_NOT_FOUND",
      "TARGET_NOT_FOUND",
      "TOKEN_NOT_FOUND",
    ]);
    const tokenErr = errors.find((e) => e.code === "TOKEN_NOT_FOUND")!;
    expect(tokenErr.message).toContain("primary-blue"); // suggestion surfaced
  });

  it("flags duplicate op ids, missing XOR source, and duplicate in-batch paths", () => {
    const model = emptySite();
    const errors = prevalidateOps(
      model,
      [
        { op: "create_page", id: "a", name: "One", path: "/one" },
        { op: "create_page", id: "a", name: "Two", path: "/one" },
        { op: "duplicate_page", name: "Three", path: "/three" },
      ],
      ctx
    );
    const codes = errors.map((e) => e.code).sort();
    expect(codes).toEqual(["DUPLICATE_OP_ID", "INVALID_TARGET", "PATH_TAKEN"]);
  });

  it("accepts a fully valid batch", () => {
    const { model, rootTplIid } = siteWithPage("Home", "/");
    const errors = prevalidateOps(
      model,
      [
        { op: "create_page", id: "pg", name: "About", path: "/about" },
        {
          op: "add_element",
          id: "el",
          parentIid: "$pg.rootTpl",
          tag: "div",
          type: "text",
          text: "hi",
        },
        { op: "apply_token", rsIid: "$el.rs", prop: "color", token: "primary-blue" },
        {
          op: "add_element",
          parentIid: rootTplIid,
          tag: "div",
          type: "other",
        },
      ],
      ctx
    );
    expect(errors).toEqual([]);
  });
});

describe("resolveToken", () => {
  it("matches by uuid, exact name, then case-insensitive name", () => {
    expect(resolveToken(TOKENS, "tokPrimary1")).toMatchObject({
      ok: true,
      uuid: "tokPrimary1",
    });
    expect(resolveToken(TOKENS, "primary-blue")).toMatchObject({
      ok: true,
      uuid: "tokPrimary1",
    });
    expect(resolveToken(TOKENS, "Primary-Blue")).toMatchObject({
      ok: true,
      uuid: "tokPrimary1",
    });
  });

  it("returns closest-name suggestions on a miss", () => {
    const res = resolveToken(TOKENS, "primry-blue");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain("primary-blue");
  });
});
