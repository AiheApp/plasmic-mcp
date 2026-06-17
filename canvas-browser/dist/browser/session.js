import { chromium } from "playwright-core";
import { env } from "../env.js";
export class PlasmicBrowserSession {
    browser;
    page;
    async connect(debugUrl = env.chromeDebugUrl) {
        this.browser = await chromium.connectOverCDP(debugUrl);
    }
    async findStudioPage(projectId) {
        if (!this.browser)
            throw new Error("Not connected. Call connect() first.");
        const contexts = this.browser.contexts();
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
        throw new Error(`No open Plasmic Studio tab found for project "${projectId}". ` +
            `Open ${env.studioHost}/projects/${projectId} in Chrome first.`);
    }
    getPage() {
        if (!this.page)
            throw new Error("No Studio page selected. Call findStudioPage() first.");
        return this.page;
    }
    async close() {
        // Don't close the browser — it's the user's own Chrome session.
        // Just release our reference.
        this.browser = undefined;
        this.page = undefined;
    }
}
export async function withStudioPage(projectId, fn) {
    const session = new PlasmicBrowserSession();
    await session.connect();
    await session.findStudioPage(projectId);
    try {
        return await fn(session.getPage());
    }
    finally {
        await session.close();
    }
}
//# sourceMappingURL=session.js.map