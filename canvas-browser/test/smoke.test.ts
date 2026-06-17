import { describe, it, expect } from "vitest";
import { PlasmicBrowserSession } from "../src/browser/session.js";
import { getCanvasState, takeScreenshot } from "../src/browser/canvas-ops.js";
import { env } from "../src/env.js";

// These tests require:
//   1. Chrome running with --remote-debugging-port=9222
//   2. Plasmic Studio open at studio.aihe.dev/projects/{PLASMIC_PROJECT_ID}
//   3. RUN_INTEGRATION=true in env
describe.runIf(process.env.RUN_INTEGRATION === "true")("live Chrome smoke tests", () => {
  const projectId = process.env.PLASMIC_PROJECT_ID;

  it("connects to Chrome via CDP", async () => {
    if (!projectId) throw new Error("PLASMIC_PROJECT_ID required for smoke tests");
    const session = new PlasmicBrowserSession();
    await expect(session.connect(env.chromeDebugUrl)).resolves.toBeUndefined();
    await session.close();
  });

  it("finds the Studio tab for the configured project", async () => {
    if (!projectId) throw new Error("PLASMIC_PROJECT_ID required");
    const session = new PlasmicBrowserSession();
    await session.connect();
    const page = await session.findStudioPage(projectId);
    expect(page.url()).toContain(projectId);
    await session.close();
  });

  it("getCanvasState returns studioCtx data (not an error)", async () => {
    if (!projectId) throw new Error("PLASMIC_PROJECT_ID required");
    const session = new PlasmicBrowserSession();
    await session.connect();
    await session.findStudioPage(projectId);
    const state = await getCanvasState(session.getPage());
    expect(state.raw).toBeDefined();
    // If window.dbg is available, studioCtx should not be an error
    const raw = state.raw as { studioCtx?: { error?: string } };
    if (raw.studioCtx && typeof raw.studioCtx === "object") {
      expect(raw.studioCtx.error).toBeUndefined();
    }
    await session.close();
  });

  it("takeScreenshot returns a non-empty base64 PNG", async () => {
    if (!projectId) throw new Error("PLASMIC_PROJECT_ID required");
    const session = new PlasmicBrowserSession();
    await session.connect();
    await session.findStudioPage(projectId);
    const png = await takeScreenshot(session.getPage());
    expect(typeof png).toBe("string");
    expect(png.length).toBeGreaterThan(1000);
    await session.close();
  });
});
