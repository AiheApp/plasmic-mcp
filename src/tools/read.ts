import { defineTool, type ToolDef } from "./types.js";
import {
  ListProjectsInput,
  GetProjectMetaInput,
  GetProjectRevWithoutDataInput,
  GetPkgByProjectInput,
  ListUnpublishedRevisionsInput,
  GetPkgPublishStatusInput,
  GetWorkspaceInput,
  GetDevflagsInput,
  ListTokensInput,
} from "../schemas.js";

const enc = encodeURIComponent;

export const readTools: ToolDef[] = [
  defineTool({
    name: "plasmic_list_projects",
    description:
      "List Plasmic projects visible to the authenticated account. No input.",
    schema: ListProjectsInput,
    handler: (client) => client.get("/api/v1/projects"),
  }),
  defineTool({
    name: "plasmic_get_project_meta",
    description: "Get a project's metadata (name, workspace, permissions, etc.).",
    schema: GetProjectMetaInput,
    handler: (client, { projectId }) =>
      client.get(`/api/v1/projects/${enc(projectId)}/meta`),
  }),
  defineTool({
    name: "plasmic_get_project_rev_without_data",
    description:
      "Get a project's latest revision metadata WITHOUT the (large) bundle payload.",
    schema: GetProjectRevWithoutDataInput,
    handler: (client, { projectId }) =>
      client.get(`/api/v1/projects/${enc(projectId)}/revision-without-data`),
  }),
  defineTool({
    name: "plasmic_get_pkg_by_project",
    description: "Get the publishable package info for a project.",
    schema: GetPkgByProjectInput,
    handler: (client, { projectId }) =>
      client.get(`/api/v1/projects/${enc(projectId)}/pkg`),
  }),
  defineTool({
    name: "plasmic_list_unpublished_revisions",
    description:
      "List unpublished revisions for a project (useful to check before publishing).",
    schema: ListUnpublishedRevisionsInput,
    handler: (client, { projectId }) =>
      client.get(`/api/v1/projects/${enc(projectId)}/revs/unpublished`),
  }),
  defineTool({
    name: "plasmic_get_pkg_publish_status",
    description: "Get the publish status of a specific package version.",
    schema: GetPkgPublishStatusInput,
    handler: (client, { projectId, pkgVersionId }) =>
      client.get(
        `/api/v1/projects/${enc(projectId)}/pkgs/${enc(pkgVersionId)}/status`
      ),
  }),
  defineTool({
    name: "plasmic_get_workspace",
    description: "Get a workspace's details and permissions.",
    schema: GetWorkspaceInput,
    handler: (client, { workspaceId }) =>
      client.get(`/api/v1/workspaces/${enc(workspaceId)}`),
  }),
  defineTool({
    name: "plasmic_get_devflags",
    description:
      "Get the instance-wide devflag overrides (raw JSON string under `data`). Requires an admin account.",
    schema: GetDevflagsInput,
    handler: (client) => client.get("/api/v1/admin/devflags"),
  }),
  defineTool({
    name: "plasmic_list_tokens",
    description:
      "List all style tokens (colors, typography, spacing, etc.) in a Plasmic project. Returns uuid, name, type, value, isRegistered for each token.",
    schema: ListTokensInput,
    handler: (client, { projectId }) =>
      client.get(`/api/v1/projects/${enc(projectId)}/tokens`),
  }),
];
