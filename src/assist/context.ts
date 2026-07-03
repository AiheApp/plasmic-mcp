/**
 * Pre-run project context: fetch the model + tokens once, extract pages /
 * code components, and render the prompt template with them.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { PlasmicClient } from "../client.js";
import { isRef, deref, type ModelNode, type PlasmicModel, type Ref } from "../model/index.js";
import { toolByName } from "./tools.js";

export interface PageInfo {
  iid: string;
  name: string;
  path: string | null;
}

export interface TokenInfo {
  uuid: string;
  name: string;
  type: string;
  value: string;
}

export interface ComponentInfo {
  iid: string;
  name: string;
  importPath: string | null;
}

export interface AssistContext {
  revision: number;
  model: PlasmicModel;
  projectName: string;
  pages: PageInfo[];
  tokens: TokenInfo[];
  components: ComponentInfo[];
}

async function runTool<T>(
  client: PlasmicClient,
  name: string,
  args: Record<string, unknown>
): Promise<T> {
  const def = toolByName(name);
  if (!def) throw new Error(`assist context: tool ${name} not available`);
  return (await def.handler(client, args as never)) as T;
}

export async function gatherContext(
  client: PlasmicClient,
  projectId: string
): Promise<AssistContext> {
  const { revision, model } = await runTool<{ revision: number; model: PlasmicModel }>(
    client,
    "plasmic_get_page_model",
    { projectId }
  );

  const pages: PageInfo[] = [];
  const components: ComponentInfo[] = [];
  for (const [iid, node] of Object.entries(model.map)) {
    if (node.__type !== "Component") continue;
    const comp = node as ModelNode & {
      name: string;
      type?: string;
      pageMeta?: Ref | null;
      codeComponentMeta?: Ref | null;
    };
    if (comp.type === "page") {
      const pm = deref<ModelNode & { path?: string }>(model, comp.pageMeta ?? null);
      pages.push({ iid, name: comp.name, path: pm?.path ?? null });
    } else if (comp.codeComponentMeta && isRef(comp.codeComponentMeta)) {
      const ccm = deref<ModelNode & { importPath?: string }>(
        model,
        comp.codeComponentMeta
      );
      components.push({ iid, name: comp.name, importPath: ccm?.importPath ?? null });
    }
  }
  pages.sort((a, b) => (a.path ?? "").localeCompare(b.path ?? ""));

  let tokens: TokenInfo[] = [];
  try {
    const raw = await runTool<unknown>(client, "plasmic_list_tokens", { projectId });
    const list = Array.isArray(raw)
      ? raw
      : ((raw as { tokens?: unknown[] })?.tokens ?? []);
    tokens = (list as Record<string, unknown>[]).map((t) => ({
      uuid: String(t.uuid ?? t.id ?? ""),
      name: String(t.name ?? ""),
      type: String(t.type ?? ""),
      value: String(t.value ?? ""),
    }));
  } catch {
    // tokens are context, not a hard dependency — proceed without them
  }

  let projectName = projectId;
  try {
    const meta = await runTool<{ project?: { name?: string } }>(
      client,
      "plasmic_get_project_meta",
      { projectId }
    );
    projectName = meta?.project?.name ?? projectId;
  } catch {
    // non-fatal
  }

  return { revision, model, projectName, pages, tokens, components };
}

// ---- template rendering -----------------------------------------------------

const TEMPLATE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "prompts",
  "design-assistant.md"
);

export function loadTemplate(path: string = TEMPLATE_PATH): string {
  return readFileSync(path, "utf8");
}

export function renderTemplate(
  template: string,
  vars: Record<string, string>
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");
}

function fmtPages(pages: PageInfo[]): string {
  if (!pages.length) return "(the project has no pages yet)";
  return pages
    .map((p) => `- **${p.name}** — path \`${p.path ?? "?"}\`, iid \`${p.iid}\``)
    .join("\n");
}

function fmtTokens(tokens: TokenInfo[]): string {
  if (!tokens.length) return "(no design tokens defined in this project)";
  const byType = new Map<string, TokenInfo[]>();
  for (const t of tokens) {
    const list = byType.get(t.type) ?? [];
    list.push(t);
    byType.set(t.type, list);
  }
  const sections: string[] = [];
  for (const [type, list] of byType) {
    sections.push(
      `**${type}:**\n` +
        list
          .map((t) => `- \`${t.name}\` = \`${t.value}\` (uuid \`${t.uuid}\`)`)
          .join("\n")
    );
  }
  return sections.join("\n\n");
}

function fmtComponents(components: ComponentInfo[]): string {
  if (!components.length) return "(no registered code components in this project)";
  return components
    .map(
      (c) =>
        `- **${c.name}**${c.importPath ? ` (from \`${c.importPath}\`)` : ""} — iid \`${c.iid}\``
    )
    .join("\n");
}

export interface RenderOptions {
  projectId: string;
  studioHost: string;
  /** Public URL for designer-facing links (may differ from the API host). */
  publicStudioUrl: string;
  templatePath?: string;
}

/** Render the design-assistant system prompt for a project. */
export function renderSystemPrompt(ctx: AssistContext, opts: RenderOptions): string {
  const studioUrl = `${opts.publicStudioUrl.replace(/\/+$/, "")}/projects/${opts.projectId}`;
  return renderTemplate(loadTemplate(opts.templatePath), {
    STUDIO_HOST: opts.studioHost,
    STUDIO_URL: studioUrl,
    PROJECT_ID: opts.projectId,
    PROJECT_NAME: ctx.projectName,
    REVISION: String(ctx.revision),
    PAGES: fmtPages(ctx.pages),
    TOKENS: fmtTokens(ctx.tokens),
    COMPONENTS: fmtComponents(ctx.components),
  });
}
