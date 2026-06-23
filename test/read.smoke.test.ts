import { describe, it, expect } from "vitest";
import { PlasmicClient } from "../src/client.js";

/**
 * Live smoke against a real self-hosted instance. Auto-skips unless all three
 * env vars are set, so the suite stays green offline / in CI without secrets.
 *
 *   PLASMIC_HOST=https://studio.aihe.dev \
 *   PLASMIC_EMAIL=... PLASMIC_PASSWORD=... npx vitest run read.smoke
 */
const { PLASMIC_HOST, PLASMIC_EMAIL, PLASMIC_PASSWORD } = process.env;
const live = Boolean(PLASMIC_HOST && PLASMIC_EMAIL && PLASMIC_PASSWORD);

describe.skipIf(!live)("live read smoke", () => {
  it("logs in and lists projects", async () => {
    const client = new PlasmicClient({
      host: PLASMIC_HOST!,
      email: PLASMIC_EMAIL!,
      password: PLASMIC_PASSWORD!,
      userAgent: process.env.PLASMIC_USER_AGENT,
    });
    const result = await client.get("/api/v1/projects");
    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
  }, 30_000);
});
