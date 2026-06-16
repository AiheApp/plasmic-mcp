import { defineTool, type ToolDef } from "./types.js";
import { PlasmicError } from "../client.js";
import { CreateProjectInput, CreateProjectWithHostlessPackagesInput, CloneProjectInput, UpdateProjectMetaInput, UpdateProjectMetaCheck, PublishProjectInput, SetDevflagsInput, GrantRevokeInput, GrantRevokeCheck } from "../schemas.js";

const enc = encodeURIComponent;

export const writeTools: ToolDef[] = [
  defineTool({ name: "plasmic_create_project", description: "Create a new (empty) Plasmic project.", schema: CreateProjectInput, handler: (client, args) => client.post("/api/v1/projects", args) }),
  defineTool({ name: "plasmic_create_project_with_hostless_packages", description: "Create a project pre-wired with one or more hostless npm packages.", schema: CreateProjectWithHostlessPackagesInput, handler: (client, args) => client.post("/api/v1/projects/create-project-with-hostless-packages", args) }),
  defineTool({ name: "plasmic_clone_project", description: "Clone an existing project into a new project.", schema: CloneProjectInput, handler: (client, { projectId, ...body }) => client.post(`/api/v1/projects/${enc(projectId)}/clone`, body) }),
  defineTool({
    name: "plasmic_update_project_meta",
    description: "Update a project's metadata. Only provided fields change.",
    schema: UpdateProjectMetaInput,
    handler: (client, args) => {
      UpdateProjectMetaCheck.parse(args);
      const { projectId, ...body } = args;
      return client.put(`/api/v1/projects/${enc(projectId)}/meta`, body);
    },
  }),
  defineTool({ name: "plasmic_publish_project", description: "Publish a project as a new package version. Requires a saved unpublished revision.", schema: PublishProjectInput, handler: (client, { projectId, ...body }) => client.post(`/api/v1/projects/${enc(projectId)}/publish`, body) }),
  defineTool({
    name: "plasmic_grant_revoke",
    description: "Grant or revoke access to projects/workspaces/teams.",
    schema: GrantRevokeInput,
    handler: (client, args) => {
      GrantRevokeCheck.parse(args);
      return client.post("/api/v1/grant-revoke", { grants: args.grants ?? [], revokes: args.revokes ?? [] });
    },
  }),
  defineTool({
    name: "plasmic_set_devflags",
    description: "Set a SINGLE instance-wide devflag key. DANGER: global (affects all Studio users). Does read-modify-write of one key. REQUIRES confirm:true. Admin account only.",
    schema: SetDevflagsInput,
    handler: async (client, { key, value, confirm }) => {
      if (confirm !== true) throw new PlasmicError("set_devflags requires confirm:true", undefined, undefined, "http");
      const current = (await client.get("/api/v1/admin/devflags")) as { data?: string };
      let merged: Record<string, unknown> = {};
      if (current?.data) {
        try {
          const parsed = JSON.parse(current.data);
          if (parsed && typeof parsed === "object") merged = parsed as Record<string, unknown>;
        } catch {
          throw new PlasmicError("existing devflag overrides are not valid JSON; refusing to clobber.", undefined, current.data.slice(0, 200), "parse");
        }
      }
      const before = merged[key];
      merged[key] = value;
      await client.put("/api/v1/admin/devflags", { data: JSON.stringify(merged) });
      return { ok: true, key, previousValue: before, newValue: value };
    },
  }),
];
