import { describe, it, expect } from "vitest";
import {
  ListPagesInput,
  GetPageModelInput,
  CreatePageInput,
  UpdatePageTextInput,
  UpdatePageTextCheck,
  AddElementInput,
  DeleteElementInput,
  ApplyTokenInput,
  UpsertComponentInput,
  DuplicatePageInput,
  GetElementInput,
} from "../src/schemas.js";

describe("model tool input schemas (strict)", () => {
  it("ListPagesInput: requires projectId, rejects extras", () => {
    expect(ListPagesInput.safeParse({ projectId: "p1" }).success).toBe(true);
    expect(ListPagesInput.safeParse({}).success).toBe(false);
    expect(ListPagesInput.safeParse({ projectId: "p1", x: 1 }).success).toBe(false);
  });

  it("GetPageModelInput: pageIid optional", () => {
    expect(GetPageModelInput.safeParse({ projectId: "p1" }).success).toBe(true);
    expect(
      GetPageModelInput.safeParse({ projectId: "p1", pageIid: "i1" }).success
    ).toBe(true);
  });

  it("CreatePageInput: name + path required, text optional", () => {
    expect(
      CreatePageInput.safeParse({ projectId: "p1", name: "N", path: "/n" }).success
    ).toBe(true);
    expect(CreatePageInput.safeParse({ projectId: "p1", name: "N" }).success).toBe(
      false
    );
    expect(
      CreatePageInput.safeParse({ projectId: "p1", name: "N", path: "/n", bogus: 1 })
        .success
    ).toBe(false);
  });

  it("UpdatePageTextCheck: needs pageIid or path", () => {
    expect(
      UpdatePageTextInput.safeParse({ projectId: "p1", text: "t" }).success
    ).toBe(true); // raw shape ok
    expect(
      UpdatePageTextCheck.safeParse({ projectId: "p1", text: "t" }).success
    ).toBe(false); // cross-field fails
    expect(
      UpdatePageTextCheck.safeParse({ projectId: "p1", text: "t", pageIid: "i1" })
        .success
    ).toBe(true);
    expect(
      UpdatePageTextCheck.safeParse({ projectId: "p1", text: "t", path: "/a" })
        .success
    ).toBe(true);
  });

  it("AddElementInput: constrains tag + type via enums", () => {
    expect(
      AddElementInput.safeParse({
        projectId: "p1",
        parentIid: "i1",
        tag: "div",
        type: "other",
      }).success
    ).toBe(true);
    expect(
      AddElementInput.safeParse({
        projectId: "p1",
        parentIid: "i1",
        tag: "marquee",
        type: "other",
      }).success
    ).toBe(false);
    expect(
      AddElementInput.safeParse({
        projectId: "p1",
        parentIid: "i1",
        tag: "div",
        type: "bogus",
      }).success
    ).toBe(false);
  });

  it("DeleteElementInput / GetElementInput: require iid", () => {
    expect(DeleteElementInput.safeParse({ projectId: "p1", iid: "i1" }).success).toBe(
      true
    );
    expect(DeleteElementInput.safeParse({ projectId: "p1" }).success).toBe(false);
    expect(GetElementInput.safeParse({ projectId: "p1", iid: "i1" }).success).toBe(
      true
    );
  });

  it("ApplyTokenInput: requires rsIid, prop, tokenId", () => {
    expect(
      ApplyTokenInput.safeParse({
        projectId: "p1",
        rsIid: "r1",
        prop: "color",
        tokenId: "t1",
      }).success
    ).toBe(true);
    expect(
      ApplyTokenInput.safeParse({ projectId: "p1", rsIid: "r1", prop: "color" })
        .success
    ).toBe(false);
  });

  it("UpsertComponentInput: name + importPath required, componentIid optional", () => {
    expect(
      UpsertComponentInput.safeParse({
        projectId: "p1",
        name: "C",
        importPath: "./C",
      }).success
    ).toBe(true);
    expect(
      UpsertComponentInput.safeParse({
        projectId: "p1",
        name: "C",
        importPath: "./C",
        componentIid: "c1",
        props: { variant: "primary" },
      }).success
    ).toBe(true);
    expect(
      UpsertComponentInput.safeParse({ projectId: "p1", name: "C" }).success
    ).toBe(false);
  });

  it("DuplicatePageInput: requires sourceIid + name + path", () => {
    expect(
      DuplicatePageInput.safeParse({
        projectId: "p1",
        sourceIid: "s1",
        name: "N",
        path: "/n",
      }).success
    ).toBe(true);
    expect(
      DuplicatePageInput.safeParse({ projectId: "p1", sourceIid: "s1" }).success
    ).toBe(false);
  });
});
