import { defineTool, type ToolDef } from "./types.js";
import { PlasmicError } from "../client.js";
import {
  CreateProjectInput,
  CreateProjectWithHostlessPackagesInput,
  CloneProjectInput,
  UpdateProjectMetaInput,
  UpdateProjectMetaCheck,
  PublishProjectInput,
  SetDevflagsInput,
  GrantRevokeInput,
  GrantRevokeCheck,
  CreateTokenInput,
  UpdateTokenInput,
  DeleteTokenInput,
  DeleteProjectInput,
  SetAppHostInput,
} from "../schemas.js";

const enc = encodeURIComponent;

export const writeTools: ToolDef[] = [
  defineTool({
    name: "plasmic_create_project",
    description:
      "Create a new (empty) Plasmic project. Optionally place it in a workspace.",
    schema: CreateProjectInput,
    handler: (client, args) => client.post("/api/v1/projects", args),
  }),
  defineTool({
    name: "plasmic_create_project_with_hostless_packages",
    description:
      "Create a project pre-wired with one or more hostless / registered npm packages.",
    schema: CreateProjectWithHostlessPackagesInput,
    handler: (client, args) =>
      client.post("/api/v1/projects/create-project-with-hostless-packages", args),
  }),
  defineTool({
    name: "plasmic_clone_project",
    description: "Clone an existing project into a new project.",
    schema: CloneProjectInput,
    handler: (client, { projectId, ...body }) =>
      client.post(`/api/v1/projects/${enc(projectId)}/clone`, body),
  }),
  defineTool({
    name: "plasmic_update_project_meta",
    description:
      "Update a project's metadata (name, workspace, access settings). Only the provided fields change.",
    schema: UpdateProjectMetaInput,
    handler: (client, args) => {
      UpdateProjectMetaCheck.parse(args); // enforce "at least one field" cross-field rule
      const { projectId, ...body } = args;
      return client.put(`/api/v1/projects/${enc(projectId)}/meta`, body);
    },
  }),
  defineTool({
    name: "plasmic_set_app_host",
    description:
      "Configure a project's custom app host (Studio: project menu → 'Configure custom app host'). Until this is set, a new project has ZERO code-component visibility. Pass the host app's /plasmic-host URL, or null to clear. Returns the previous and new values.",
    schema: SetAppHostInput,
    handler: async (client, { projectId, hostUrl, branchId }) => {
      // Best-effort read of the current value so callers see the transition.
      let previousHostUrl: string | null | undefined;
      try {
        const current = (await client.get(
          `/api/v1/projects/${enc(projectId)}`
        )) as { project?: { hostUrl?: string | null } };
        previousHostUrl = current?.project?.hostUrl ?? null;
      } catch {
        previousHostUrl = undefined; // read failed; the write still proceeds
      }
      const res = (await client.put(
        `/api/v1/projects/${enc(projectId)}/update-host`,
        branchId ? { hostUrl, branchId } : { hostUrl }
      )) as { hostUrl?: string | null; updatedAt?: string };
      return {
        projectId,
        previousHostUrl,
        hostUrl: res?.hostUrl ?? hostUrl,
        branchId: branchId ?? null,
        updatedAt: res?.updatedAt ?? null,
      };
    },
  }),
  defineTool({
    name: "plasmic_publish_project",
    description:
      "Publish a project as a new package version. Precondition: a saved unpublished revision must exist — otherwise the server returns an error, surfaced as-is.",
    schema: PublishProjectInput,
    handler: (client, { projectId, ...body }) =>
      client.post(`/api/v1/projects/${enc(projectId)}/publish`, body),
  }),
  defineTool({
    name: "plasmic_grant_revoke",
    description:
      "Grant or revoke access to projects/workspaces/teams for one or more users.",
    schema: GrantRevokeInput,
    handler: (client, args) => {
      GrantRevokeCheck.parse(args); // enforce "at least one grant or revoke"
      return client.post("/api/v1/grant-revoke", {
        grants: args.grants ?? [],
        revokes: args.revokes ?? [],
      });
    },
  }),
  defineTool({
    name: "plasmic_set_devflags",
    description:
      "Set a SINGLE instance-wide devflag override. DANGER: devflags are GLOBAL (affect every Studio user) and the underlying endpoint replaces the whole blob — this tool does a safe read-modify-write of one key and REQUIRES confirm:true. Admin account only.",
    schema: SetDevflagsInput,
    handler: async (client, { key, value, confirm }) => {
      // Belt-and-suspenders: the schema already requires confirm:true.
      if (confirm !== true) {
        throw new PlasmicError(
          "set_devflags requires confirm:true (global instance-wide write)",
          undefined,
          undefined,
          "http"
        );
      }
      // 1) read current overrides (raw JSON string under `data`)
      const current = (await client.get("/api/v1/admin/devflags")) as {
        data?: string;
      };
      let merged: Record<string, unknown> = {};
      if (current?.data) {
        try {
          const parsed = JSON.parse(current.data);
          if (parsed && typeof parsed === "object") {
            merged = parsed as Record<string, unknown>;
          }
        } catch {
          throw new PlasmicError(
            "existing devflag overrides are not valid JSON; refusing to clobber. Inspect with plasmic_get_devflags.",
            undefined,
            current.data.slice(0, 200),
            "parse"
          );
        }
      }
      // 2) merge the single key
      const before = merged[key];
      merged[key] = value;
      // 3) write the whole (merged) blob back
      await client.put("/api/v1/admin/devflags", {
        data: JSON.stringify(merged),
      });
      return { ok: true, key, previousValue: before, newValue: value };
    },
  }),
  defineTool({
    name: "plasmic_create_token",
    description:
      "Create a style token in a Plasmic project. type must be one of: Color, FontFamily, FontSize, LineHeight, Opacity, Spacing. Returns the created token with its uuid.",
    schema: CreateTokenInput,
    handler: (client, { projectId, ...body }) =>
      client.post(`/api/v1/projects/${enc(projectId)}/tokens`, body),
  }),
  defineTool({
    name: "plasmic_update_token",
    description:
      "Update a style token's name and/or value by uuid. At least one of name or value must be provided.",
    schema: UpdateTokenInput,
    handler: (client, { projectId, tokenId, ...body }) =>
      client.put(
        `/api/v1/projects/${enc(projectId)}/tokens/${enc(tokenId)}`,
        body
      ),
  }),
  defineTool({
    name: "plasmic_delete_project",
    description:
      "Permanently delete a Plasmic project by ID. This is irreversible — all revisions, pages, and components are removed.",
    schema: DeleteProjectInput,
    handler: (client, { projectId }) =>
      client.delete(`/api/v1/projects/${enc(projectId)}`),
  }),
  defineTool({
    name: "plasmic_delete_token",
    description:
      "Delete a style token by uuid. All usages in the project are inlined (replaced with the token's resolved value) before removal — no dangling references.",
    schema: DeleteTokenInput,
    handler: (client, { projectId, tokenId }) =>
      client.delete(
        `/api/v1/projects/${enc(projectId)}/tokens/${enc(tokenId)}`
      ),
  }),
];
