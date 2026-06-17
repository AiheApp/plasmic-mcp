import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { env } from "../env.js";

export class PlasmicBrowserSession {
  private browser?: Browser;
  private page?: Page;

  async connect(debugUrl: string = env.chromeDebugUrl): Promise<void> {
    this.browser = await chromium.connectOverCDP(debugUrl);
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
    // Just release our reference.
    this.browser = undefined;
    this.page = undefined;
  }
}

export async function withStudioPage<T>(
  projectId: string,
  fn: (page: Page) => Promise<T>
): Promise<T> {
  const session = new PlasmicBrowserSession();
  await session.connect();
  await session.findStudioPage(projectId);
  try {
    return await fn(session.getPage());
  } finally {
    await session.close();
  }
}
