import { describe, it, expect } from "vitest";
import {
  ApplyMutationsInput,
  CreateProjectInput,
  MutationOpSchema,
  PlanMutationsInput,
  GetProjectMetaInput,
  GetPkgPublishStatusInput,
  UpdateProjectMetaCheck,
  PublishProjectInput,
  SetDevflagsInput,
  GrantRevokeCheck,
  GenerateUiInput,
} from "../src/schemas.js";

describe("tool input schemas", () => {
  it("CreateProjectInput: accepts empty + named, rejects unknown keys", () => {
    expect(CreateProjectInput.safeParse({}).success).toBe(true);
    expect(CreateProjectInput.safeParse({ name: "x" }).success).toBe(true);
    expect(CreateProjectInput.safeParse({ bogus: 1 }).success).toBe(false);
  });

  it("GetProjectMetaInput: requires non-empty projectId", () => {
    expect(GetProjectMetaInput.safeParse({}).success).toBe(false);
    expect(GetProjectMetaInput.safeParse({ projectId: "" }).success).toBe(false);
    expect(GetProjectMetaInput.safeParse({ projectId: "p1" }).success).toBe(true);
  });

  it("GetPkgPublishStatusInput: requires both ids", () => {
    expect(GetPkgPublishStatusInput.safeParse({ projectId: "p1" }).success).toBe(
      false
    );
    expect(
      GetPkgPublishStatusInput.safeParse({ projectId: "p1", pkgVersionId: "v1" })
        .success
    ).toBe(true);
  });

  it("UpdateProjectMetaCheck: needs at least one field beyond projectId", () => {
    expect(UpdateProjectMetaCheck.safeParse({ projectId: "p1" }).success).toBe(
      false
    );
    expect(
      UpdateProjectMetaCheck.safeParse({ projectId: "p1", name: "n" }).success
    ).toBe(true);
  });

  it("PublishProjectInput: projectId required, optional version/tags", () => {
    expect(PublishProjectInput.safeParse({ projectId: "p1" }).success).toBe(true);
    expect(
      PublishProjectInput.safeParse({ projectId: "p1", tags: ["latest"] }).success
    ).toBe(true);
    expect(PublishProjectInput.safeParse({}).success).toBe(false);
  });

  it("SetDevflagsInput: confirm:true is mandatory", () => {
    expect(SetDevflagsInput.safeParse({ key: "k", value: 1 }).success).toBe(false);
    expect(
      SetDevflagsInput.safeParse({ key: "k", value: 1, confirm: false }).success
    ).toBe(false);
    expect(
      SetDevflagsInput.safeParse({ key: "k", value: 1, confirm: true }).success
    ).toBe(true);
  });

  it("GrantRevokeCheck: needs at least one grant or revoke", () => {
    expect(GrantRevokeCheck.safeParse({}).success).toBe(false);
    expect(
      GrantRevokeCheck.safeParse({
        grants: [{ email: "a@b.com", accessLevel: "editor", projectId: "p1" }],
      }).success
    ).toBe(true);
    expect(
      GrantRevokeCheck.safeParse({
        grants: [{ email: "not-an-email", accessLevel: "editor" }],
      }).success
    ).toBe(false);
  });

  it("GenerateUiInput: requires projectId + goal", () => {
    expect(GenerateUiInput.safeParse({ projectId: "p1" }).success).toBe(false);
    expect(
      GenerateUiInput.safeParse({ projectId: "p1", goal: "a hero section" })
        .success
    ).toBe(true);
    expect(
      GenerateUiInput.safeParse({
        projectId: "p1",
        goal: "x",
        images: [{ type: "png", base64: "AAA" }],
      }).success
    ).toBe(true);
  });

  it("MutationOpSchema: discriminates ops and rejects unknown keys", () => {
    expect(
      MutationOpSchema.safeParse({ op: "create_page", name: "P", path: "/p" })
        .success
    ).toBe(true);
    expect(
      MutationOpSchema.safeParse({
        op: "add_element",
        parentIid: "$pg.rootTpl",
        tag: "div",
        type: "text",
        text: "hi",
      }).success
    ).toBe(true);
    expect(
      MutationOpSchema.safeParse({
        op: "apply_token",
        rsIid: "abc",
        prop: "color",
        token: "primary-blue",
      }).success
    ).toBe(true);
    // unknown op
    expect(MutationOpSchema.safeParse({ op: "explode" }).success).toBe(false);
    // strict: extra keys rejected
    expect(
      MutationOpSchema.safeParse({
        op: "delete_element",
        iid: "x",
        bogus: 1,
      }).success
    ).toBe(false);
    // op id charset
    expect(
      MutationOpSchema.safeParse({
        op: "create_page",
        id: "1bad",
        name: "P",
        path: "/p",
      }).success
    ).toBe(false);
    // set_styles values are string|null
    expect(
      MutationOpSchema.safeParse({
        op: "set_styles",
        rsIid: "x",
        styles: { display: "flex", color: null },
      }).success
    ).toBe(true);
    expect(
      MutationOpSchema.safeParse({
        op: "set_styles",
        rsIid: "x",
        styles: { display: 3 },
      }).success
    ).toBe(false);
  });

  it("Plan/ApplyMutationsInput: ops bounds and expectedRevision", () => {
    const one = [{ op: "create_page", name: "P", path: "/p" }];
    expect(PlanMutationsInput.safeParse({ projectId: "p1", ops: one }).success).toBe(true);
    expect(PlanMutationsInput.safeParse({ projectId: "p1", ops: [] }).success).toBe(false);
    const tooMany = Array.from({ length: 51 }, () => one[0]);
    expect(PlanMutationsInput.safeParse({ projectId: "p1", ops: tooMany }).success).toBe(false);
    expect(
      ApplyMutationsInput.safeParse({ projectId: "p1", ops: one, expectedRevision: 7 }).success
    ).toBe(true);
    expect(
      ApplyMutationsInput.safeParse({ projectId: "p1", ops: one, expectedRevision: -1 }).success
    ).toBe(false);
    expect(
      ApplyMutationsInput.safeParse({ projectId: "p1", ops: one, expectedRevision: 1.5 }).success
    ).toBe(false);
  });
});
