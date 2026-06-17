import { describe, it, expect, vi } from "vitest";
import { PlasmicBrowserSession } from "../src/browser/session.js";

describe("PlasmicBrowserSession.findStudioPage", () => {
  it("throws when no matching tab is found", async () => {
    const session = new PlasmicBrowserSession();

    // Inject a mock browser with no pages containing the project ID
    const mockPage = { url: () => "https://studio.aihe.dev/projects/other-project" };
    const mockCtx = { pages: () => [mockPage] };
    const mockBrowser = { contexts: () => [mockCtx] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any).browser = mockBrowser;

    await expect(session.findStudioPage("my-project-id")).rejects.toThrow(
      'No open Plasmic Studio tab found for project "my-project-id"'
    );
  });

  it("returns the page when URL matches project ID and contains 'studio'", async () => {
    const session = new PlasmicBrowserSession();

    const targetUrl = "https://studio.aihe.dev/projects/my-project-id/components";
    const mockPage = {
      url: () => targetUrl,
      bringToFront: vi.fn().mockResolvedValue(undefined),
    };
    const mockCtx = { pages: () => [mockPage] };
    const mockBrowser = { contexts: () => [mockCtx] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any).browser = mockBrowser;

    const page = await session.findStudioPage("my-project-id");
    expect(page.url()).toBe(targetUrl);
    expect(mockPage.bringToFront).toHaveBeenCalledOnce();
  });
});
