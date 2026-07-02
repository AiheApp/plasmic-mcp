import { z } from "zod";

/**
 * Strict zod input schemas, one per tool. Exported as z.objects so they can be
 * unit-tested directly and passed to the MCP server as `.shape`.
 */

const projectId = z.string().min(1, "projectId is required");
const workspaceId = z.string().min(1, "workspaceId is required");

// ---- reads ----
export const ListProjectsInput = z.object({}).strict();

export const GetProjectMetaInput = z.object({ projectId }).strict();

export const GetProjectRevWithoutDataInput = z.object({ projectId }).strict();

export const GetPkgByProjectInput = z.object({ projectId }).strict();

export const ListUnpublishedRevisionsInput = z.object({ projectId }).strict();

export const GetPkgPublishStatusInput = z
  .object({
    projectId,
    pkgVersionId: z.string().min(1, "pkgVersionId is required"),
  })
  .strict();

export const GetWorkspaceInput = z.object({ workspaceId }).strict();

export const GetDevflagsInput = z.object({}).strict();

// ---- safe writes ----
export const CreateProjectInput = z
  .object({
    name: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
  })
  .strict();

const hostLessPackageInfo = z
  .object({
    name: z.string().min(1),
    npmPkg: z.array(z.string().min(1)).optional(),
    cssImport: z.array(z.string()).optional(),
    deps: z.array(z.string()).optional(),
    registerCalls: z.array(z.string()).optional(),
  })
  .passthrough();

export const CreateProjectWithHostlessPackagesInput = z
  .object({
    name: z.string().min(1, "name is required"),
    hostLessPackagesInfo: z
      .array(hostLessPackageInfo)
      .min(1, "at least one hostless package is required"),
    workspaceId: z.string().min(1).optional(),
  })
  .strict();

export const CloneProjectInput = z
  .object({
    projectId,
    name: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
  })
  .strict();

export const UpdateProjectMetaInput = z
  .object({
    projectId,
    name: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
    inviteOnly: z.boolean().optional(),
    defaultAccessLevel: z.string().min(1).optional(),
    readableByPublic: z.boolean().optional(),
  })
  .strict();

/** Cross-field rule enforced in the handler (MCP validates only the raw shape). */
export const UpdateProjectMetaCheck = UpdateProjectMetaInput.refine(
  (v) => Object.keys(v).some((k) => k !== "projectId"),
  "provide at least one field to update besides projectId"
);

export const PublishProjectInput = z
  .object({
    projectId,
    version: z.string().min(1).optional(),
    tags: z.array(z.string()).optional(),
    description: z.string().optional(),
  })
  .strict();

export const SetDevflagsInput = z
  .object({
    key: z.string().min(1, "key is required"),
    value: z.unknown(),
    confirm: z
      .literal(true, {
        errorMap: () => ({
          message:
            "set_devflags writes a GLOBAL, instance-wide override (affects all Studio users). Pass confirm:true to proceed.",
        }),
      })
      .describe("must be true — guards against blind instance-wide writes"),
  })
  .strict();

const grant = z
  .object({
    email: z.string().email(),
    accessLevel: z.string().min(1),
    projectId: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
    teamId: z.string().min(1).optional(),
  })
  .strict();

const revoke = z
  .object({
    email: z.string().email(),
    projectId: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
    teamId: z.string().min(1).optional(),
  })
  .strict();

export const GrantRevokeInput = z
  .object({
    grants: z.array(grant).optional(),
    revokes: z.array(revoke).optional(),
  })
  .strict();

/** Cross-field rule enforced in the handler (MCP validates only the raw shape). */
export const GrantRevokeCheck = GrantRevokeInput.refine(
  (v) => (v.grants?.length ?? 0) + (v.revokes?.length ?? 0) > 0,
  "provide at least one grant or revoke"
);

// ---- tokens ----
const TOKEN_TYPES = [
  "Color",
  "FontFamily",
  "FontSize",
  "LineHeight",
  "Opacity",
  "Spacing",
] as const;

export const ListTokensInput = z.object({ projectId }).strict();

export const CreateTokenInput = z
  .object({
    projectId,
    name: z.string().min(1, "name is required"),
    type: z.enum(TOKEN_TYPES),
    value: z.string().min(1, "value is required"),
  })
  .strict();

export const UpdateTokenInput = z
  .object({
    projectId,
    tokenId: z.string().min(1, "tokenId is required"),
    name: z.string().min(1).optional(),
    value: z.string().optional(),
  })
  .strict();

export const DeleteProjectInput = z
  .object({ projectId })
  .strict();

export const DeleteTokenInput = z
  .object({
    projectId,
    tokenId: z.string().min(1, "tokenId is required"),
  })
  .strict();

// ---- copilot ----
const copilotImage = z
  .object({
    type: z.enum(["png", "jpg", "jpeg", "webp"]),
    base64: z.string().min(1),
  })
  .strict();

export const GenerateUiInput = z
  .object({
    projectId,
    goal: z.string().min(1, "goal is required"),
    images: z.array(copilotImage).optional(),
    tokens: z.array(z.unknown()).optional(),
    copilotSystemPromptOverride: z.string().optional(),
  })
  .strict();
