import { describe, it, expect } from "vitest";
import { PlasmicClient } from "../src/client.js";
import { batchTools } from "../src/tools/batch.js";
import {
  serializeModel,
  findNodesByType,
  findPageByPath,
  tokenRefValue,
  type ModelNode,
  type PlasmicModel,
  type TokenInfo,
} from "../src/model/index.js";
import { emptySite, siteWithPage } from "./fixtures/site.js";

function tool(name: string) {
  const def = batchTools.find((t) => t.name === name);
  if (!def) throw new Error(`tool not found: ${name}`);
  return def;
}

const TOKENS: TokenInfo[] = [
  { uuid: "tokPrimary1", name: "primary-blue", type: "Color", value: "#4169e1" },
];

/**
 * Same fake-fetch client as model.tools.test.ts, extended with the project
 * /tokens route and a save-POST counter (the atomicity assertions key on it).
 */
function makeClient(model: PlasmicModel, revision: number, tokens: TokenInfo[] = TOKENS) {
  const captured: {
    body?: Record<string, unknown>;
    savedModel?: PlasmicModel;
    saveCount: number;
  } = { saveCount: 0 };
  const data = serializeModel(model);
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const path = (typeof url === "string" ? url : url.toString()).replace(
      /^https?:\/\/[^/]+/,
      ""
    );
    const json = (status: number, obj: unknown) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (method === "GET" && path === "/api/v1/auth/csrf")
      return json(200, { csrf: "tok" });
    if (method === "POST" && path === "/api/v1/auth/login")
      return json(200, { status: true, user: { id: "u1" } });
    if (method === "GET" && /^\/api\/v1\/projects\/[^/]+\/tokens$/.test(path))
      return json(200, { tokens });
    if (method === "GET" && /^\/api\/v1\/projects\/[^/]+$/.test(path))
      return json(200, { rev: { revision, data } });
    const saveMatch = path.match(/^\/api\/v1\/projects\/[^/]+\/revisions\/(\d+)$/);
    if (method === "POST" && saveMatch) {
      const body = JSON.parse(init!.body as string) as Record<string, unknown>;
      captured.body = body;
      captured.savedModel = JSON.parse(body.data as string) as PlasmicModel;
      captured.saveCount++;
      return json(200, { rev: { revision: Number(saveMatch[1]) } });
    }
    return json(404, { error: `no mock for ${method} ${path}` });
  }) as unknown as typeof fetch;

  const client = new PlasmicClient({
    host: "https://studio.test",
    email: "svc@test.dev",
    password: "pw",
    fetchImpl,
  });
  return { client, captured };
}

const HERO_BATCH = [
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

describe("plasmic_plan_mutations", () => {
  it("validates a batch and never saves", async () => {
    const { client, captured } = makeClient(emptySite(), 7);
    const res = (await tool("plasmic_plan_mutations").handler(client, {
      projectId: "p1",
      ops: HERO_BATCH,
    })) as {
      valid: boolean;
      applied: boolean;
      baseRevision: number;
      preview: string;
      summary: Record<string, number>;
    };
    expect(res.valid).toBe(true);
    expect(res.applied).toBe(false);
    expect(res.baseRevision).toBe(7);
    expect(res.summary).toMatchObject({
      pagesAdded: 1,
      elementsAdded: 1,
      tokensApplied: 1,
    });
    expect(res.preview).toContain("revision 7");
    expect(res.preview).toContain('page "Pricing" at /pricing');
    expect(captured.saveCount).toBe(0);
  });

  it("refuses with per-op errors and does not save", async () => {
    const { client, captured } = makeClient(siteWithPage("Home", "/").model, 3);
    const res = (await tool("plasmic_plan_mutations").handler(client, {
      projectId: "p1",
      ops: [
        { op: "create_page", name: "Home2", path: "/" }, // PATH_TAKEN
        { op: "delete_element", iid: "missing000000" }, // TARGET_NOT_FOUND
        { op: "set_text", path: "/", text: "ok" }, // fine
      ],
    })) as { valid: boolean; errors: { opIndex: number; code: string }[] };
    expect(res.valid).toBe(false);
    expect(res.errors.map((e) => e.code).sort()).toEqual([
      "PATH_TAKEN",
      "TARGET_NOT_FOUND",
    ]);
    expect(res.errors.find((e) => e.code === "PATH_TAKEN")!.opIndex).toBe(0);
    expect(captured.saveCount).toBe(0);
  });
});

describe("plasmic_apply_mutations", () => {
  it("applies a whole batch in ONE revision save", async () => {
    const { client, captured } = makeClient(emptySite(), 7);
    const res = (await tool("plasmic_apply_mutations").handler(client, {
      projectId: "p1",
      ops: HERO_BATCH,
      expectedRevision: 7,
    })) as {
      applied: boolean;
      revision: number;
      ids: Record<string, Record<string, string>>;
    };
    expect(res.applied).toBe(true);
    expect(res.revision).toBe(8);
    expect(captured.saveCount).toBe(1);
    expect(captured.body!.revisionNum).toBe(8);
    const saved = captured.savedModel!;
    const pageIid = findPageByPath(saved, "/pricing")!;
    expect(pageIid).toBe(res.ids.pg.iid);
    expect(captured.body!.modifiedComponentIids).toEqual([pageIid]);
    const rs = saved.map[res.ids.h1.rs] as ModelNode & {
      values: Record<string, string>;
    };
    expect(rs.values.color).toBe(tokenRefValue("tokPrimary1"));
  });

  it("aborts with REVISION_CONFLICT on a stale expectedRevision, no save", async () => {
    const { client, captured } = makeClient(emptySite(), 9);
    const res = (await tool("plasmic_apply_mutations").handler(client, {
      projectId: "p1",
      ops: HERO_BATCH,
      expectedRevision: 8,
    })) as { applied: boolean; code: string; headRevision: number };
    expect(res.applied).toBe(false);
    expect(res.code).toBe("REVISION_CONFLICT");
    expect(res.headRevision).toBe(9);
    expect(captured.saveCount).toBe(0);
  });

  it("a mid-batch failure applies NOTHING (zero saves)", async () => {
    const { model, rootTplIid } = siteWithPage("Home", "/", "Hello");
    const { client, captured } = makeClient(model, 4);
    const res = (await tool("plasmic_apply_mutations").handler(client, {
      projectId: "p1",
      ops: [
        {
          op: "add_element",
          parentIid: rootTplIid,
          tag: "div",
          type: "text",
          text: "ok",
        },
        { op: "set_text", path: "/", text: "fine" },
        // fails at trial-execution time: $ghost was never declared
        { op: "delete_element", iid: "$ghost" },
        { op: "create_page", name: "P", path: "/p" },
      ],
    })) as { applied: boolean; errors: { opIndex: number; code: string }[] };
    expect(res.applied).toBe(false);
    expect(res.errors[0]).toMatchObject({ opIndex: 2, code: "UNKNOWN_REF" });
    expect(captured.saveCount).toBe(0);
  });

  it("re-validates against the fresh head when expectedRevision is omitted", async () => {
    const { model } = siteWithPage("Home", "/", "Old");
    const { client, captured } = makeClient(model, 2);
    const res = (await tool("plasmic_apply_mutations").handler(client, {
      projectId: "p1",
      ops: [{ op: "set_text", path: "/", text: "New" }],
    })) as { applied: boolean; revision: number };
    expect(res.applied).toBe(true);
    expect(res.revision).toBe(3);
    const raws = findNodesByType(captured.savedModel!, "RawText").map(
      (iid) => (captured.savedModel!.map[iid] as { text: string }).text
    );
    expect(raws).toEqual(["New"]);
  });
});
