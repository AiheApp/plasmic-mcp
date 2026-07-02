import { describe, it, expect } from "vitest";
import { PlasmicClient } from "../src/client.js";
import { modelTools } from "../src/tools/model.js";
import {
  serializeModel,
  findNodesByType,
  type ModelNode,
  type PlasmicModel,
  type Ref,
} from "../src/model/index.js";
import { emptySite, siteWithPage } from "./fixtures/site.js";

function tool(name: string) {
  const def = modelTools.find((t) => t.name === name);
  if (!def) throw new Error(`tool not found: ${name}`);
  return def;
}

/**
 * A PlasmicClient backed by a fake fetch that serves one project revision and
 * captures the save-revision POST body. Returns the parsed saved bundle + body.
 */
function makeClient(model: PlasmicModel, revision: number) {
  const captured: { body?: Record<string, unknown>; savedModel?: PlasmicModel } = {};
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
    if (method === "GET" && /^\/api\/v1\/projects\/[^/]+$/.test(path))
      return json(200, { rev: { revision, data } });
    const saveMatch = path.match(/^\/api\/v1\/projects\/[^/]+\/revisions\/(\d+)$/);
    if (method === "POST" && saveMatch) {
      const body = JSON.parse(init!.body as string) as Record<string, unknown>;
      captured.body = body;
      captured.savedModel = JSON.parse(body.data as string) as PlasmicModel;
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

describe("model tools (mocked client)", () => {
  it("plasmic_create_page: inv5/6/7 via the captured save body", async () => {
    const { client, captured } = makeClient(emptySite(), 5);
    const res = (await tool("plasmic_create_page").handler(client, {
      projectId: "p1",
      name: "Home",
      path: "/",
      text: "Hi",
    })) as { pageIid: string; arenaIid: string; revision: number };

    expect(res.revision).toBe(6);
    // inv7: revisionNum = currentRevision + 1
    expect(captured.body!.revisionNum).toBe(6);
    // inv6: modifiedComponentIids includes the new page component
    expect(captured.body!.modifiedComponentIids).toEqual([res.pageIid]);
    // inv5: Site.components AND Site.pageArenas both grew, in sync
    const site = captured.savedModel!.map[captured.savedModel!.root] as ModelNode & {
      components: Ref[];
      pageArenas: Ref[];
    };
    expect(site.components.some((r) => r.__ref === res.pageIid)).toBe(true);
    expect(site.pageArenas.some((r) => r.__ref === res.arenaIid)).toBe(true);
  });

  it("plasmic_list_pages returns the page summary", async () => {
    const { model } = siteWithPage("About", "/about", undefined);
    const { client } = makeClient(model, 2);
    const res = (await tool("plasmic_list_pages").handler(client, {
      projectId: "p1",
    })) as { count: number; pages: { name: string; path: string }[] };
    expect(res.count).toBe(1);
    expect(res.pages[0]).toMatchObject({ name: "About", path: "/about" });
  });

  it("plasmic_add_element inserts under a parent and records the owner", async () => {
    const { model, rootTplIid, pageIid } = siteWithPage();
    const { client, captured } = makeClient(model, 3);
    const res = (await tool("plasmic_add_element").handler(client, {
      projectId: "p1",
      parentIid: rootTplIid,
      tag: "div",
      type: "other",
    })) as { elementIid: string; owner: string | null };
    expect(res.owner).toBe(pageIid);
    expect(captured.body!.modifiedComponentIids).toEqual([pageIid]);
    const saved = captured.savedModel!;
    const parent = saved.map[rootTplIid] as ModelNode & { children: Ref[] };
    expect(parent.children.some((r) => r.__ref === res.elementIid)).toBe(true);
  });

  it("plasmic_delete_element removes the node from the saved model", async () => {
    const { model, rootTplIid } = siteWithPage("Home", "/", "Hello");
    const textTplIid = (model.map[rootTplIid] as ModelNode & { children: Ref[] })
      .children[0].__ref;
    const { client, captured } = makeClient(model, 7);
    await tool("plasmic_delete_element").handler(client, {
      projectId: "p1",
      iid: textTplIid,
    });
    expect(textTplIid in captured.savedModel!.map).toBe(false);
  });

  it("plasmic_update_page_text replaces RawText content", async () => {
    const { model, pageIid } = siteWithPage("Home", "/", "Old");
    const { client, captured } = makeClient(model, 1);
    const res = (await tool("plasmic_update_page_text").handler(client, {
      projectId: "p1",
      pageIid,
      text: "New",
    })) as { updated: number };
    expect(res.updated).toBe(1);
    const raws = findNodesByType(captured.savedModel!, "RawText").map(
      (iid) => (captured.savedModel!.map[iid] as { text: string }).text
    );
    expect(raws).toContain("New");
    expect(raws).not.toContain("Old");
  });

  it("plasmic_apply_token wires a CSS var ref into the ruleset", async () => {
    const { model } = siteWithPage();
    const rsIid = findNodesByType(model, "RuleSet")[0];
    const { client, captured } = makeClient(model, 1);
    const res = (await tool("plasmic_apply_token").handler(client, {
      projectId: "p1",
      rsIid,
      prop: "color",
      tokenId: "tok123",
    })) as { value: string };
    expect(res.value).toBe("var(--token-tok123)");
    const rs = captured.savedModel!.map[rsIid] as { values: Record<string, string> };
    expect(rs.values.color).toBe("var(--token-tok123)");
  });

  it("plasmic_duplicate_page clones component + arena with a new path", async () => {
    const { model, pageIid } = siteWithPage("Home", "/", "Hello");
    const { client, captured } = makeClient(model, 4);
    const res = (await tool("plasmic_duplicate_page").handler(client, {
      projectId: "p1",
      sourceIid: pageIid,
      name: "Home Copy",
      path: "/home-copy",
    })) as { pageIid: string; arenaIid: string | null };
    expect(res.pageIid).not.toBe(pageIid);
    const saved = captured.savedModel!;
    expect(findNodesByType(saved, "Component").length).toBe(2);
    expect(findNodesByType(saved, "PageArena").length).toBe(2);
    const clone = saved.map[res.pageIid] as ModelNode & { name: string; pageMeta: Ref };
    expect(clone.name).toBe("Home Copy");
    expect((saved.map[clone.pageMeta.__ref] as { path: string }).path).toBe(
      "/home-copy"
    );
  });

  it("plasmic_get_element reads styles/text/children by iid", async () => {
    const { model, rootTplIid } = siteWithPage("Home", "/", "Hello");
    const { client } = makeClient(model, 1);
    const textTplIid = (model.map[rootTplIid] as ModelNode & { children: Ref[] })
      .children[0].__ref;
    const res = (await tool("plasmic_get_element").handler(client, {
      projectId: "p1",
      iid: textTplIid,
    })) as { text: string | null; __type: string; type: string | null };
    expect(res.__type).toBe("TplTag");
    expect(res.type).toBe("text");
    expect(res.text).toBe("Hello");
  });

  it("plasmic_upsert_component (create) registers a code component", async () => {
    const { client, captured } = makeClient(emptySite(), 1);
    const res = (await tool("plasmic_upsert_component").handler(client, {
      projectId: "p1",
      name: "MyButton",
      importPath: "./MyButton",
    })) as { componentIid: string };
    const saved = captured.savedModel!;
    const comp = saved.map[res.componentIid] as ModelNode & {
      type: string;
      codeComponentMeta: Ref;
    };
    expect(comp.type).toBe("code");
    expect((saved.map[comp.codeComponentMeta.__ref] as { importPath: string }).importPath).toBe(
      "./MyButton"
    );
  });
});
