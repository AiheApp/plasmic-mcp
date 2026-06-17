import { describe, it, expect, beforeEach, afterEach } from "vitest";

describe("env defaults", () => {
  it("studioHost defaults to studio.aihe.dev", async () => {
    const { env } = await import("../src/env.js");
    expect(env.studioHost).toBe("https://studio.aihe.dev");
  });

  it("chromeDebugUrl defaults to localhost:9222", async () => {
    const { env } = await import("../src/env.js");
    expect(env.chromeDebugUrl).toBe("http://localhost:9222");
  });
});

describe("resolveProjectId", () => {
  const originalId = process.env.PLASMIC_PROJECT_ID;

  beforeEach(() => {
    delete process.env.PLASMIC_PROJECT_ID;
  });

  afterEach(() => {
    if (originalId !== undefined) process.env.PLASMIC_PROJECT_ID = originalId;
    else delete process.env.PLASMIC_PROJECT_ID;
  });

  it("uses override when provided", async () => {
    const { resolveProjectId } = await import("../src/env.js");
    expect(resolveProjectId("my-project-123")).toBe("my-project-123");
  });

  it("throws a descriptive error when no projectId is available", async () => {
    const { resolveProjectId } = await import("../src/env.js");
    expect(() => resolveProjectId()).toThrow("projectId is required");
  });

  it("falls back to PLASMIC_PROJECT_ID env var", async () => {
    process.env.PLASMIC_PROJECT_ID = "env-project-456";
    // Re-import to pick up the new env value
    const { resolveProjectId } = await import("../src/env.js");
    expect(resolveProjectId()).toBe("env-project-456");
  });
});
