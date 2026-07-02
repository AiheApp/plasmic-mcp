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

// ---- model mutation (pages / elements) ----
const iid = (label: string) => z.string().min(1, `${label} is required`);

/** TplTag.type values the model accepts (from model-schema.ts). */
const TPL_TAG_TYPES = ["text", "image", "column", "columns", "other"] as const;
/** A small set of safe HTML tags for new elements. */
const ELEMENT_TAGS = ["div", "span", "p", "a", "img", "button", "section"] as const;

export const ListPagesInput = z.object({ projectId }).strict();

export const GetPageModelInput = z
  .object({
    projectId,
    /** Optional: scope the returned graph to a single page's subtree. */
    pageIid: z.string().min(1).optional(),
  })
  .strict();

export const CreatePageInput = z
  .object({
    projectId,
    name: z.string().min(1, "name is required"),
    path: z.string().min(1, "path is required"),
    text: z.string().optional(),
  })
  .strict();

export const UpdatePageTextInput = z
  .object({
    projectId,
    /** Select the page by component iid... */
    pageIid: z.string().min(1).optional(),
    /** ...or by its URL path. */
    path: z.string().min(1).optional(),
    text: z.string(),
    /** Optional: only update this single RawText node. */
    textIid: z.string().min(1).optional(),
  })
  .strict();

/** Cross-field rule enforced in the handler (MCP validates only the raw shape). */
export const UpdatePageTextCheck = UpdatePageTextInput.refine(
  (v) => Boolean(v.pageIid || v.path),
  "provide either pageIid or path to select the page"
);

export const AddElementInput = z
  .object({
    projectId,
    parentIid: iid("parentIid"),
    tag: z.enum(ELEMENT_TAGS),
    type: z.enum(TPL_TAG_TYPES),
    baseVariantIid: z.string().min(1).optional(),
    text: z.string().optional(),
  })
  .strict();

export const DeleteElementInput = z
  .object({ projectId, iid: iid("iid") })
  .strict();

export const ApplyTokenInput = z
  .object({
    projectId,
    rsIid: iid("rsIid"),
    prop: z.string().min(1, "prop is required"),
    /** Token uuid — wired as a CSS var ref into the RuleSet value. */
    tokenId: iid("tokenId"),
  })
  .strict();

export const UpsertComponentInput = z
  .object({
    projectId,
    name: z.string().min(1, "name is required"),
    importPath: z.string().min(1, "importPath is required"),
    /** Existing component iid to update; omit to create. */
    componentIid: z.string().min(1).optional(),
    props: z.record(z.unknown()).optional(),
  })
  .strict();

export const DuplicatePageInput = z
  .object({
    projectId,
    sourceIid: iid("sourceIid"),
    name: z.string().min(1, "name is required"),
    path: z.string().min(1, "path is required"),
  })
  .strict();

export const GetElementInput = z
  .object({ projectId, iid: iid("iid") })
  .strict();

// ---- batch mutations ----

/**
 * Local handle for an op's outputs. Later ops reference them as "$<id>" (the
 * primary iid) or "$<id>.<field>" (e.g. "$hero.rootTpl", "$cta.rs").
 * Cross-field rules that zod discriminated unions can't express (XOR fields,
 * forward references, duplicate ids) are enforced by prevalidateOps.
 */
const opId = z
  .string()
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_-]*$/,
    "op id must start with a letter and contain only letters/digits/_/-"
  )
  .optional();

/** A literal iid or a "$id"/"$id.field" placeholder. */
const iidOrRef = (label: string) => z.string().min(1, `${label} is required`);

const CreatePageOp = z
  .object({
    op: z.literal("create_page"),
    id: opId,
    name: z.string().min(1, "name is required"),
    path: z.string().min(1, "path is required"),
    text: z.string().optional(),
  })
  .strict();

const DuplicatePageOp = z
  .object({
    op: z.literal("duplicate_page"),
    id: opId,
    /** Exactly one of sourceIid / sourcePath (checked in prevalidateOps). */
    sourceIid: z.string().min(1).optional(),
    sourcePath: z.string().min(1).optional(),
    name: z.string().min(1, "name is required"),
    path: z.string().min(1, "path is required"),
  })
  .strict();

const AddElementOp = z
  .object({
    op: z.literal("add_element"),
    id: opId,
    parentIid: iidOrRef("parentIid"),
    tag: z.enum(ELEMENT_TAGS),
    type: z.enum(TPL_TAG_TYPES),
    text: z.string().optional(),
    baseVariantIid: z.string().min(1).optional(),
  })
  .strict();

const SetTextOp = z
  .object({
    op: z.literal("set_text"),
    /** Select the page by iid/placeholder or by path (one required). */
    pageIid: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    /** Optional: only update this single RawText node. */
    textIid: z.string().min(1).optional(),
    text: z.string(),
  })
  .strict();

const DeleteElementOp = z
  .object({
    op: z.literal("delete_element"),
    iid: iidOrRef("iid"),
  })
  .strict();

const ApplyTokenOp = z
  .object({
    op: z.literal("apply_token"),
    rsIid: iidOrRef("rsIid"),
    prop: z.string().min(1, "prop is required"),
    /** Token uuid OR exact token name (e.g. "primary-blue"). */
    token: z.string().min(1, "token is required"),
  })
  .strict();

const SetStylesOp = z
  .object({
    op: z.literal("set_styles"),
    rsIid: iidOrRef("rsIid"),
    /** CSS property map; a null value deletes that property. */
    styles: z.record(z.union([z.string(), z.null()])),
  })
  .strict();

export const MutationOpSchema = z.discriminatedUnion("op", [
  CreatePageOp,
  DuplicatePageOp,
  AddElementOp,
  SetTextOp,
  DeleteElementOp,
  ApplyTokenOp,
  SetStylesOp,
]);

const ops = z
  .array(MutationOpSchema)
  .min(1, "ops must contain at least one mutation")
  .max(50, "ops is capped at 50 mutations per batch");

export const PlanMutationsInput = z.object({ projectId, ops }).strict();

export const ApplyMutationsInput = z
  .object({
    projectId,
    ops,
    /**
     * Pass the baseRevision returned by plasmic_plan_mutations; apply aborts
     * with REVISION_CONFLICT if the project has advanced past it.
     */
    expectedRevision: z.number().int().nonnegative().optional(),
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
