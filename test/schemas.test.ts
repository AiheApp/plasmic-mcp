import { describe, it, expect } from "vitest";
import {
  CreateProjectInput,
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
});
