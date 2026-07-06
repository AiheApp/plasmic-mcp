import { describe, it, expect, vi } from "vitest";

// Simulates a wedged browser: launch() succeeds but no page/frame ever
// exposes window.dbg.studioCtx, so openStudio must exhaust all attempts.
let launchCount = 0;
vi.mock("playwright", () => {
  return {
    chromium: {
      launch: vi.fn(async () => {
        launchCount++;
        return {
          isConnected: () => true,
          close: vi.fn(async () => {}),
          newContext: vi.fn(async () => ({
            addInitScript: vi.fn(async () => {}),
            addCookies: vi.fn(async () => {}),
            newPage: vi.fn(async () => ({
              goto: vi.fn(async () => {}),
              frames: vi.fn(() => []),
            })),
            close: vi.fn(async () => {}),
          })),
        };
      }),
    },
  };
});

const { StudioDriver, CanvasError } = await import("../src/browser/driver.js");

const fakeClient = {
  host: "https://studio.example",
  getCookies: async () => [],
} as any;

describe("StudioDriver browser self-heal", () => {
  it("recycles a wedged browser so the next openStudio launches a fresh one", async () => {
    const driver = new StudioDriver(fakeClient);

    await expect(
      driver.openStudio("p1", { waitMs: 10, attempts: 1 })
    ).rejects.toThrow(CanvasError);
    expect(launchCount).toBe(1);

    // Without the self-heal, getBrowser() would reuse the same (wedged but
    // "connected") browser instance forever instead of relaunching.
    await expect(
      driver.openStudio("p1", { waitMs: 10, attempts: 1 })
    ).rejects.toThrow(CanvasError);
    expect(launchCount).toBe(2);
  });
});
