import { describe, it, expect } from "vitest";
import { PlasmicClient, PlasmicError } from "../src/client.js";

// ---- mock fetch infrastructure ----
interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}

function jsonRes(status: number, obj: unknown, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
}
function htmlRes(status: number, text: string) {
  return new Response(text, { status, headers: { "content-type": "text/html" } });
}
function textRes(status: number, text: string) {
  return new Response(text, { status, headers: { "content-type": "text/plain" } });
}

interface State {
  csrfCount: number;
  loginCount: number;
  counts: Record<string, number>;
}

function makeMock(
  responder: (call: Call, state: State) => Response | undefined
) {
  const calls: Call[] = [];
  const state: State = { csrfCount: 0, loginCount: 0, counts: {} };

  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const u = typeof url === "string" ? url : url.toString();
    const path = u.replace(/^https?:\/\/[^/]+/, "");
    const headers: Record<string, string> = {};
    const h = (init?.headers ?? {}) as Record<string, string>;
    for (const k of Object.keys(h)) headers[k.toLowerCase()] = h[k];
    const call: Call = { method, path, headers, body: init?.body as string };
    calls.push(call);

    // auth handshake handled automatically
    if (method === "GET" && path === "/api/v1/auth/csrf") {
      state.csrfCount++;
      return jsonRes(200, { csrf: `tok${state.csrfCount}` }, {
        "set-cookie": "connect.sid=sess1; Path=/; HttpOnly",
      });
    }
    if (method === "POST" && path === "/api/v1/auth/login") {
      state.loginCount++;
      const custom = responder(call, state);
      if (custom) return custom;
      return jsonRes(200, { status: true, user: { id: "u1" } });
    }
    const r = responder(call, state);
    if (r) return r;
    return jsonRes(404, { error: "no mock for " + method + " " + path });
  }) as unknown as typeof fetch;

  return { fetchImpl, calls, state };
}

function client(fetchImpl: typeof fetch) {
  return new PlasmicClient({
    host: "https://studio.test",
    email: "svc@test.dev",
    password: "pw",
    fetchImpl,
  });
}

describe("PlasmicClient auth + request", () => {
  it("logs in (csrf→login→csrf), reads, and attaches csrf+cookie on mutations", async () => {
    const { fetchImpl, calls } = makeMock((call) => {
      if (call.method === "GET" && call.path === "/api/v1/projects")
        return jsonRes(200, [{ id: "p1" }]);
      if (call.method === "POST" && call.path === "/api/v1/projects")
        return jsonRes(200, { id: "p2" });
      return undefined;
    });
    const c = client(fetchImpl);

    expect(await c.get("/api/v1/projects")).toEqual([{ id: "p1" }]);
    expect(await c.post("/api/v1/projects", { name: "x" })).toEqual({ id: "p2" });

    // login order: csrf(tok1) → login → csrf(tok2); csrfToken ends as tok2
    const post = calls.find(
      (c2) => c2.method === "POST" && c2.path === "/api/v1/projects"
    )!;
    expect(post.headers["x-csrf-token"]).toBe("tok2");
    expect(post.headers["cookie"]).toContain("connect.sid=sess1");

    // the GET read must NOT carry a csrf header
    const get = calls.find(
      (c2) => c2.method === "GET" && c2.path === "/api/v1/projects"
    )!;
    expect(get.headers["x-csrf-token"]).toBeUndefined();
  });

  it("surfaces a Cloudflare WAF 403 (HTML) as kind=waf, not a JSON parse crash", async () => {
    const { fetchImpl } = makeMock((call) =>
      call.path === "/api/v1/projects"
        ? htmlRes(403, "<html><body>Cloudflare: request blocked</body></html>")
        : undefined
    );
    const err = await client(fetchImpl)
      .get("/api/v1/projects")
      .catch((e) => e);
    expect(err).toBeInstanceOf(PlasmicError);
    expect((err as PlasmicError).kind).toBe("waf");
    expect((err as PlasmicError).status).toBe(403);
  });

  it("re-authenticates once on a 401 and retries the request", async () => {
    const { fetchImpl, state } = makeMock((call, st) => {
      if (call.path === "/api/v1/projects" && call.method === "GET") {
        st.counts.proj = (st.counts.proj ?? 0) + 1;
        return st.counts.proj === 1
          ? jsonRes(401, { error: "unauthorized" })
          : jsonRes(200, { ok: true });
      }
      return undefined;
    });
    const c = client(fetchImpl);
    expect(await c.get("/api/v1/projects")).toEqual({ ok: true });
    // initial login + one re-login = 2 logins
    expect(state.loginCount).toBe(2);
  });

  it("re-authenticates on a 403 CSRF-mismatch body, then retries", async () => {
    const { fetchImpl, state } = makeMock((call, st) => {
      if (call.path === "/api/v1/projects/p1/meta" && call.method === "PUT") {
        st.counts.meta = (st.counts.meta ?? 0) + 1;
        return st.counts.meta === 1
          ? textRes(403, "CSRF token mismatch")
          : jsonRes(200, { updated: true });
      }
      return undefined;
    });
    const c = client(fetchImpl);
    expect(await c.put("/api/v1/projects/p1/meta", { name: "n" })).toEqual({
      updated: true,
    });
    expect(state.loginCount).toBe(2);
  });

  it("surfaces a 500 as kind=http with the status", async () => {
    const { fetchImpl } = makeMock((call) =>
      call.path === "/api/v1/projects"
        ? jsonRes(500, { error: "boom" })
        : undefined
    );
    const err = await client(fetchImpl)
      .get("/api/v1/projects")
      .catch((e) => e);
    expect(err).toBeInstanceOf(PlasmicError);
    expect((err as PlasmicError).kind).toBe("http");
    expect((err as PlasmicError).status).toBe(500);
  });

  it("surfaces a copilot 503 as a structured error (no retry loop)", async () => {
    const { fetchImpl, state } = makeMock((call) =>
      call.path === "/api/v1/copilot/ui"
        ? jsonRes(503, { error: "overloaded" })
        : undefined
    );
    const c = client(fetchImpl);
    const err = await c
      .post("/api/v1/copilot/ui", { projectId: "p1", goal: "x" }, 60000)
      .catch((e) => e);
    expect((err as PlasmicError).status).toBe(503);
    // 503 is not an auth failure → no re-login
    expect(state.loginCount).toBe(1);
  });

  it("surfaces an abort/timeout as kind=timeout", async () => {
    const { fetchImpl } = makeMock((call) => {
      if (call.path === "/slow") {
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      }
      return undefined;
    });
    const err = await client(fetchImpl)
      .get("/slow")
      .catch((e) => e);
    expect((err as PlasmicError).kind).toBe("timeout");
  });

  it("rejects a bad login (status:false) as kind=auth", async () => {
    const { fetchImpl } = makeMock((call) =>
      call.method === "POST" && call.path === "/api/v1/auth/login"
        ? jsonRes(200, { status: false, reason: "IncorrectLoginError" })
        : undefined
    );
    const err = await client(fetchImpl)
      .get("/api/v1/projects")
      .catch((e) => e);
    expect((err as PlasmicError).kind).toBe("auth");
    expect((err as Error).message).toContain("IncorrectLoginError");
  });
});
