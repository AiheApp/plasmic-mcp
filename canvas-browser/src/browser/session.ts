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

async function navigateToStudio(ctx: BrowserContext, projectId: string): Promise<Page> {
  const url = `${env.studioHost}/projects/${projectId}`;
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });
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
  }

  // Step 2: Find an already-open Studio tab for this project
  let page: Page | undefined;
  const contexts = browser.contexts();
  for (const ctx of contexts) {
    for (const p of ctx.pages()) {
      if (p.url().includes(projectId) && p.url().includes("studio")) {
        page = p;
        await page.bringToFront();
        break;
      }
    }
    if (page) break;
  }

  // Step 3: No matching tab — open one
  if (!page) {
    const ctx = contexts[0] ?? await (browser as Browser & { newContext(): Promise<BrowserContext> }).newContext();
    page = await navigateToStudio(ctx, projectId);
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
