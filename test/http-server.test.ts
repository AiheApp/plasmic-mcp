import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { PlasmicClient } from "../src/client.js";
import { createHandler } from "../src/http-server.js";
import { serializeModel, type PlasmicModel } from "../src/model/index.js";
import { emptySite } from "./fixtures/site.js";

const SECRET = "test-secret";

/**
 * Fake Studio: auth handshake, one project (create/get/rev/save/publish/delete).
 * Mirrors the makeClient() pattern from model.tools.test.ts, extended with the
 * project-CRUD endpoints the HTTP wrapper exercises.
 */
function makeClient(model: PlasmicModel, revision: number) {
  const captured: { saves: number; deleted?: string; published?: string } = { saves: 0 };
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
    if (method === "GET" && path === "/api/v1/auth/csrf") return json(200, { csrf: "tok" });
    if (method === "POST" && path === "/api/v1/auth/login")
      return json(200, { status: true, user: { id: "u1" } });
    if (method === "POST" && path === "/api/v1/projects")
      return json(200, { project: { id: "proj-new", projectApiToken: "tok-new" } });
    if (method === "GET" && /^\/api\/v1\/projects\/[^/]+$/.test(path))
      return json(200, { rev: { revision, data }, project: { id: "p1", projectApiToken: "tok-p1" } });
    const saveMatch = path.match(/^\/api\/v1\/projects\/[^/]+\/revisions\/(\d+)$/);
    if (method === "POST" && saveMatch) {
      captured.saves++;
      return json(200, { rev: { revision: Number(saveMatch[1]) } });
    }
    const pubMatch = path.match(/^\/api\/v1\/projects\/([^/]+)\/publish$/);
    if (method === "POST" && pubMatch) {
      captured.published = pubMatch[1];
      return json(200, { pkg: { version: "0.0.1" } });
    }
    const delMatch = path.match(/^\/api\/v1\/projects\/([^/]+)$/);
    if (method === "DELETE" && delMatch) {
      captured.deleted = delMatch[1];
      return json(200, {});
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

let server: Server | undefined;

async function startServer(model = emptySite(), revision = 5) {
  const { client, captured } = makeClient(model, revision);
  server = createServer(createHandler({ secret: SECRET, client }));
  await new Promise<void>((r) => server!.listen(0, r));
  const { port } = server!.address() as { port: number };
  const call = (
    path: string,
    opts: { method?: string; body?: unknown; auth?: string | null } = {}
  ) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: opts.method ?? "POST",
      headers: {
        "content-type": "application/json",
        ...(opts.auth === null ? {} : { authorization: `Bearer ${opts.auth ?? SECRET}` }),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  return { call, captured };
}

afterEach(async () => {
  if (server) await new Promise((r) => server!.close(r));
  server = undefined;
});

describe("plasmic-page-api HTTP wrapper", () => {
  it("GET /health needs no auth", async () => {
    const { call } = await startServer();
    const res = await call("/health", { method: "GET", auth: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "plasmic-page-api" });
  });

  it("rejects missing/wrong bearer with 401", async () => {
    const { call } = await startServer();
    expect((await call("/add-page", { body: {}, auth: null })).status).toBe(401);
    expect((await call("/add-page", { body: {}, auth: "nope" })).status).toBe(401);
  });

  it("unknown route → 404", async () => {
    const { call } = await startServer();
    expect((await call("/nope", { body: {} })).status).toBe(404);
  });

  it("POST /add-page accepts the legacy n8n contract (pageName) and saves a revision", async () => {
    const { call, captured } = await startServer(emptySite(), 5);
    const res = await call("/add-page", {
      body: { projectId: "p1", pageName: "Home", path: "/", text: "Hi" },
    });
    const body = (await res.json()) as { ok: boolean; revision: number; pageIid: string };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.revision).toBe(6);
    expect(body.pageIid).toBeTruthy();
    expect(captured.saves).toBe(1);
  });

  it("POST /add-page with bad input → 400 with zod issues", async () => {
    const { call } = await startServer();
    const res = await call("/add-page", { body: { projectId: "p1" } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; issues: string[] };
    expect(body.ok).toBe(false);
    expect(body.issues.join(" ")).toMatch(/name|path/);
  });

  it("POST /create-project returns projectId + projectApiToken", async () => {
    const { call } = await startServer();
    const res = await call("/create-project", { body: { name: "site-x" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      projectId: "proj-new",
      projectToken: "tok-new",
      name: "site-x",
    });
  });

  it("POST /publish-project and /delete-project hit the right endpoints", async () => {
    const { call, captured } = await startServer();
    const pub = await call("/publish-project", { body: { projectId: "p1" } });
    expect(pub.status).toBe(200);
    expect(captured.published).toBe("p1");
    const del = await call("/delete-project", { body: { projectId: "p1" } });
    expect(del.status).toBe(200);
    expect(captured.deleted).toBe("p1");
  });
});
