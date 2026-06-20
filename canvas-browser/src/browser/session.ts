import { exec } from "child_process";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { env } from "../env.js";

// ---------------------------------------------------------------------------
// Chrome auto-launch
// ---------------------------------------------------------------------------

function launchChrome(projectId: string): void {
  const url = `${env.studioHost}/projects/${projectId}`;
  // macOS: open Chrome with the remote-debugging port and navigate to Studio.
  // Use a DEDICATED user-data-dir so the debug instance starts reliably even
  // when the user's main Chrome is already running on the default profile
  // (Chrome ignores --remote-debugging-port if an instance with that profile
  // is already open). This dedicated profile is the canvas-browser sandbox.
  const cmd = [
    "open", "-na", '"Google Chrome"', "--args",
    "--remote-debugging-port=9222",
    "--user-data-dir=/tmp/chrome-studio-cdp",
    `"${url}"`,
  ].join(" ");
  exec(cmd, () => {}); // fire-and-forget; errors surface on the next connect attempt
}

async function pollForChrome(debugUrl: string, timeoutMs = 15_000): Promise<Browser> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      return await chromium.connectOverCDP(debugUrl);
    } catch (err) {
      lastErr = err;
      await new Promise(r => setTimeout(r, 800));
    }
  }
  throw new Error(
    `Could not connect to Chrome at ${debugUrl} after ${timeoutMs / 1000}s. ` +
    `Make sure Google Chrome is installed at /Applications/Google Chrome.app. ` +
    `(${(lastErr as Error)?.message ?? "connection refused"})`
  );
}

/** True when creds are configured for cold-start auto-authentication. */
function hasCreds(): boolean {
  return !!(env.email && env.password);
}

/**
 * Authenticate the browser CONTEXT by logging in via the API and injecting the
 * session cookie. No page navigation — call this BEFORE navigating to Studio so
 * the first load is already authed (proven more reliable than a reactive reload,
 * which can leave the cross-origin inner editor unauthenticated). No-op return
 * false unless PLASMIC_EMAIL/PLASMIC_PASSWORD are set.
 */
async function authenticateContext(ctx: BrowserContext): Promise<boolean> {
  if (!hasCreds()) return false;
  const host = env.studioHost;
  const jar = new Map<string, string>();
  const storeCookies = (res: { headers: { getSetCookie?: () => string[] } }) => {
    const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const line of raw) {
      const [nv] = line.split(";");
      const eq = nv.indexOf("=");
      if (eq > 0) jar.set(nv.slice(0, eq).trim(), nv.slice(eq + 1).trim());
    }
  };
  const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  const api = async (method: string, path: string, body?: unknown, csrf?: string) => {
    const headers: Record<string, string> = { "content-type": "application/json", cookie: cookieHeader() };
    if (csrf) headers["x-csrf-token"] = csrf;
    const res = await fetch(`${host}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    storeCookies(res);
    return res.json().catch(() => ({} as Record<string, unknown>));
  };
  const r1 = (await api("GET", "/api/v1/auth/csrf")) as { csrf?: string };
  const r2 = (await api("POST", "/api/v1/auth/login", { email: env.email, password: env.password }, r1.csrf)) as { status?: boolean };
  if (r2.status !== true) {
    throw new Error("Studio login failed — check PLASMIC_EMAIL/PLASMIC_PASSWORD.");
  }
  await api("GET", "/api/v1/auth/csrf"); // post-login session regeneration
  const domain = new URL(host).hostname;
  await ctx.addCookies(
    [...jar.entries()].map(([name, value]) => ({
      name, value, domain, path: "/", httpOnly: false, secure: host.startsWith("https"), sameSite: "Lax" as const,
    }))
  );
  return true;
}

/**
 * Reactive fallback: if a tab landed on the login page, authenticate + reload.
 * Returns true if it (re)authenticated.
 */
async function ensureAuthed(ctx: BrowserContext, page: Page): Promise<boolean> {
  const onLogin =
    page.url().includes("/login") ||
    (await page.title().catch(() => "")).toLowerCase().includes("sign in");
  if (!onLogin) return false;
  if (!hasCreds()) {
    throw new Error(
      "Studio needs login and no credentials are available. Log in to " +
        `${env.studioHost} once in the debug Chrome, or set PLASMIC_EMAIL and ` +
        "PLASMIC_PASSWORD so canvas-browser can authenticate on a cold start."
    );
  }
  await authenticateContext(ctx);
  await page.reload({ waitUntil: "domcontentloaded" });
  return true;
}

async function navigateToStudio(ctx: BrowserContext, projectId: string): Promise<Page> {
  const url = `${env.studioHost}/projects/${projectId}`;
  // Proactively authenticate the context BEFORE the first navigation when creds
  // are set — the proven path. Injecting after a login redirect (reactive) can
  // leave the cross-origin inner editor (canvas.aihe.dev) unauthenticated.
  if (hasCreds()) {
    await authenticateContext(ctx);
  }
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  // Reactive fallback in case the proactive auth didn't apply / creds absent.
  if (await ensureAuthed(ctx, page)) {
    await page.goto(url, { waitUntil: "domcontentloaded" });
  }
  await page.waitForSelector("iframe.studio-frame", { timeout: 60_000 });
  return page;
}

// ---------------------------------------------------------------------------
// Session class
// ---------------------------------------------------------------------------

export class PlasmicBrowserSession {
  private browser?: Browser;
  private page?: Page;

  async connect(debugUrl: string = env.chromeDebugUrl): Promise<void> {
    try {
      this.browser = await chromium.connectOverCDP(debugUrl);
    } catch (err) {
      const msg = (err as Error)?.message ?? "";
      if (msg.includes("ECONNREFUSED") || msg.includes("connect")) {
        throw new Error(
          `Chrome is not running with remote debugging enabled.\n` +
          `Run this command to open Chrome with Studio:\n\n` +
          `  open -na "Google Chrome" --args --remote-debugging-port=9222 "${env.studioHost}/projects/YOUR_PROJECT_ID"\n\n` +
          `Or call any canvas tool and it will launch Chrome automatically if PLASMIC_PROJECT_ID is set.`
        );
      }
      throw err;
    }
  }

  async findStudioPage(projectId: string): Promise<Page> {
    if (!this.browser) throw new Error("Not connected. Call connect() first.");
    const contexts: BrowserContext[] = this.browser.contexts();
    for (const ctx of contexts) {
      for (const page of ctx.pages()) {
        const url = page.url();
        if (url.includes(projectId) && url.includes("studio")) {
          this.page = page;
          await page.bringToFront();
          return page;
        }
      }
    }
    throw new Error(
      `No open Plasmic Studio tab found for project "${projectId}". ` +
      `Open ${env.studioHost}/projects/${projectId} in Chrome first.`
    );
  }

  getPage(): Page {
    if (!this.page) throw new Error("No Studio page selected. Call findStudioPage() first.");
    return this.page;
  }

  async close(): Promise<void> {
    // Don't close the browser — it's the user's own Chrome session.
    this.browser = undefined;
    this.page = undefined;
  }
}

// ---------------------------------------------------------------------------
// withStudioPage — auto-launches Chrome + navigates if needed
// ---------------------------------------------------------------------------

export async function withStudioPage<T>(
  projectId: string,
  fn: (page: Page) => Promise<T>
): Promise<T> {
  const debugUrl = env.chromeDebugUrl;
  let browser: Browser;

  // Step 1: Try to connect to an existing Chrome debug instance
  try {
    browser = await chromium.connectOverCDP(debugUrl);
  } catch {
    // Chrome not running — launch it pointed at the project, then poll
    launchChrome(projectId);
    browser = await pollForChrome(debugUrl);
    // Let a freshly-launched Chrome fully initialize before navigating —
    // connecting/navigating too early leaves the inner editor frame unloaded.
    await new Promise((r) => setTimeout(r, 8000));
  }

  // Step 2: Find an already-open Studio tab for this project. Exclude the login
  // page (its URL also contains the projectId via ?continueTo=), so a cold,
  // unauthenticated tab doesn't get mistaken for a ready Studio editor.
  let page: Page | undefined;
  const contexts = browser.contexts();
  for (const ctx of contexts) {
    for (const p of ctx.pages()) {
      const url = p.url();
      if (url.includes(projectId) && url.includes("studio") && !url.includes("/login")) {
        page = p;
        await page.bringToFront();
        break;
      }
    }
    if (page) break;
  }

  // Step 3: No matching tab — open one (navigateToStudio authenticates if the
  // cold profile lands on the login page and creds are configured).
  if (!page) {
    const ctx = contexts[0] ?? await (browser as Browser & { newContext(): Promise<BrowserContext> }).newContext();
    page = await navigateToStudio(ctx, projectId);
  } else {
    // A matching tab exists but may be unauthenticated/stale — ensure auth.
    if (await ensureAuthed(page.context(), page)) {
      await page.goto(`${env.studioHost}/projects/${projectId}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("iframe.studio-frame", { timeout: 60_000 });
    }
  }

  // Step 3.5: Grant clipboard permission so studio_insert_html can write to the
  // clipboard and paste. Best-effort — not all CDP contexts support this.
  try {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  } catch {
    // ignore — insert_html will surface a clear error if the paste can't run
  }

  // Step 4: Run the operation
  try {
    return await fn(page);
  } finally {
    browser.close().catch(() => {}); // release CDP reference only; doesn't close Chrome
  }
}
