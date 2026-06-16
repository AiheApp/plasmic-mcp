/**
 * PlasmicClient — session + CSRF auth against a self-hosted Plasmic instance.
 *
 * WHY SESSION+CSRF (not a personal API token): the personal
 * `x-plasmic-api-token` + `x-plasmic-api-user` pair is authenticated by
 * `authApiTokenMiddleware` but most MUTATING routes still pass through
 * `lusca.csrf()` unless the path is CSRF-free or the request is a
 * project/CMS/team-token "public API" request — the personal pair is NOT.
 * So personal-token GETs work but POST /projects, …/clone, …/meta, …/publish,
 * /grant-revoke, /copilot/ui are all CSRF-rejected. A real browser session is
 * the only auth that reaches them, so we replicate it.
 *
 *   AUTH HANDSHAKE
 *   ──────────────
 *   GET  /api/v1/auth/csrf   → { csrf }   (establishes anon session cookie)
 *        │  send csrf as X-CSRF-Token (login itself is CSRF-protected)
 *        ▼
 *   POST /api/v1/auth/login  { email, password } → { status:true, user }
 *        │  passport may regenerate the session id → its csrf token changes
 *        ▼
 *   GET  /api/v1/auth/csrf   → { csrf }   (token bound to the AUTHED session)
 *        ▼
 *   …all subsequent mutations carry the authed cookie + that csrf token.
 *
 * Reads (GET/HEAD) need no csrf. On a 401 (or a 403 whose body says CSRF) the
 * client re-authenticates once and retries — covers session/csrf expiry.
 */

export interface PlasmicClientConfig {
  host: string;
  email: string;
  password: string;
  userAgent?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export type PlasmicErrorKind =
  | "waf"
  | "auth"
  | "http"
  | "parse"
  | "timeout"
  | "network";

export class PlasmicError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
    readonly kind?: PlasmicErrorKind
  ) {
    super(message);
    this.name = "PlasmicError";
  }
}

interface RawOpts {
  body?: unknown;
  csrf?: boolean;
  timeoutMs?: number;
}

interface RawResult {
  status: number;
  contentType: string;
  text: string;
}

const DEFAULT_UA = "plasmic-mcp/0.1 (+https://studio.aihe.dev)";

export class PlasmicClient {
  private readonly host: string;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;

  private cookies = new Map<string, string>();
  private csrfToken: string | undefined;
  private authed = false;
  private loginInFlight: Promise<void> | undefined;

  constructor(private readonly cfg: PlasmicClientConfig) {
    this.host = cfg.host.replace(/\/+$/, "");
    this.userAgent = cfg.userAgent ?? DEFAULT_UA;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private storeCookies(res: Response): void {
    const headers = res.headers as Headers & { getSetCookie?: () => string[] };
    const raw =
      typeof headers.getSetCookie === "function"
        ? headers.getSetCookie()
        : headers.get("set-cookie")
          ? [headers.get("set-cookie") as string]
          : [];
    for (const cookie of raw) {
      const first = cookie.split(";", 1)[0];
      const eq = first.indexOf("=");
      if (eq <= 0) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      if (name) this.cookies.set(name, value);
    }
  }

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private async send(
    method: string,
    path: string,
    opts: RawOpts = {}
  ): Promise<RawResult> {
    const headers: Record<string, string> = {
      "user-agent": this.userAgent,
      accept: "application/json",
    };
    const cookie = this.cookieHeader();
    if (cookie) headers.cookie = cookie;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.csrf && this.csrfToken) headers["x-csrf-token"] = this.csrfToken;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.host}${path}`, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        redirect: "manual",
        signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
      });
    } catch (e: unknown) {
      const name = (e as { name?: string })?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new PlasmicError(
          `${method} ${path} timed out after ${opts.timeoutMs}ms`,
          undefined,
          undefined,
          "timeout"
        );
      }
      throw new PlasmicError(
        `${method} ${path} network error: ${(e as Error)?.message ?? e}`,
        undefined,
        undefined,
        "network"
      );
    }

    this.storeCookies(res);
    const text = await res.text();
    return { status: res.status, contentType: res.headers.get("content-type") ?? "", text };
  }

  private interpret(r: RawResult, ctx: string): unknown {
    const isJson = r.contentType.includes("application/json");
    if (!isJson) {
      const looksHtml =
        r.contentType.includes("text/html") || /<html|cloudflare/i.test(r.text);
      if (r.status === 403 && looksHtml) {
        throw new PlasmicError(
          `WAF blocked (${ctx}) — check User-Agent / Cloudflare rule`,
          r.status,
          r.text.slice(0, 200),
          "waf"
        );
      }
      if (r.status < 200 || r.status >= 300) {
        throw new PlasmicError(`${ctx} failed: HTTP ${r.status}`, r.status, r.text.slice(0, 500), "http");
      }
      return r.text;
    }

    let json: unknown;
    try {
      json = r.text ? JSON.parse(r.text) : {};
    } catch {
      throw new PlasmicError(`${ctx}: invalid JSON response`, r.status, r.text.slice(0, 200), "parse");
    }
    if (r.status < 200 || r.status >= 300) {
      throw new PlasmicError(`${ctx} failed: HTTP ${r.status}`, r.status, JSON.stringify(json).slice(0, 500), "http");
    }
    return json;
  }

  private async fetchCsrf(): Promise<void> {
    const r = await this.send("GET", "/api/v1/auth/csrf");
    const json = this.interpret(r, "csrf") as { csrf?: string };
    if (!json?.csrf) {
      throw new PlasmicError("csrf: missing token in response", r.status, undefined, "auth");
    }
    this.csrfToken = json.csrf;
  }

  async login(): Promise<void> {
    if (this.loginInFlight) return this.loginInFlight;
    this.loginInFlight = (async () => {
      await this.fetchCsrf();
      const r = await this.send("POST", "/api/v1/auth/login", {
        body: { email: this.cfg.email, password: this.cfg.password },
        csrf: true,
      });
      const json = this.interpret(r, "login") as { status?: boolean; reason?: string };
      if (json?.status !== true) {
        throw new PlasmicError(`login failed: ${json?.reason ?? "unknown"}`, r.status, undefined, "auth");
      }
      await this.fetchCsrf();
      this.authed = true;
    })();
    try {
      await this.loginInFlight;
    } finally {
      this.loginInFlight = undefined;
    }
  }

  private async ensureAuth(): Promise<void> {
    if (!this.authed) await this.login();
  }

  async request<T = unknown>(
    method: string,
    path: string,
    opts: { body?: unknown; timeoutMs?: number } = {}
  ): Promise<T> {
    await this.ensureAuth();
    const mutating = method !== "GET" && method !== "HEAD";
    let r = await this.send(method, path, { body: opts.body, csrf: mutating, timeoutMs: opts.timeoutMs });

    const stale = r.status === 401 || (r.status === 403 && /csrf/i.test(r.text));
    if (stale) {
      this.authed = false;
      await this.login();
      r = await this.send(method, path, { body: opts.body, csrf: mutating, timeoutMs: opts.timeoutMs });
    }
    return this.interpret(r, `${method} ${path}`) as T;
  }

  get<T = unknown>(path: string, timeoutMs?: number): Promise<T> {
    return this.request<T>("GET", path, { timeoutMs });
  }
  post<T = unknown>(path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    return this.request<T>("POST", path, { body, timeoutMs });
  }
  put<T = unknown>(path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    return this.request<T>("PUT", path, { body, timeoutMs });
  }
}
