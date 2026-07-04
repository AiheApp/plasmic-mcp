/**
 * Live canvas integration suite — exercises the full hardened insert path
 * against the real Studio instance. Gated: only runs with PLASMIC_LIVE=1.
 *
 *   PLASMIC_LIVE=1 npx vitest run test/canvas.live.test.ts
 *
 * Creates a scratch project (tokens seeded via REST), inserts every template
 * plus one raw-HTML case, asserts REST-verified node deltas, then deletes the
 * project.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
loadEnv({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".env") });

import { PlasmicClient } from "../src/client.js";
import { insertHtmlOp } from "../src/tools/canvas.js";
import { TEMPLATES, renderTemplate } from "../src/templates/index.js";
import { DS_TOKENS } from "../src/templates/tokens.js";
import { fetchRev } from "../src/tools/model.js";

const LIVE = process.env.PLASMIC_LIVE === "1";
const d = LIVE ? describe : describe.skip;

const SAMPLE_PARAMS: Record<string, unknown> = {
  hero: { title: "Live Hero", subtitle: "sub", ctaText: "Go" },
  cardGrid: { heading: "Cards", cards: [{ title: "A", body: "a" }, { title: "B", body: "b" }] },
  formSection: { title: "Contact", fields: [{ label: "Email", type: "email" }] },
  twoColumnLayout: { leftHtml: "<p>L</p>", rightHtml: "<p>R</p>" },
  emptyState: { title: "Empty", description: "Nothing yet." },
};

d("canvas live", () => {
  let client: PlasmicClient;
  let projectId: string;

  beforeAll(async () => {
    client = new PlasmicClient({
      host: process.env.PLASMIC_HOST!,
      email: process.env.PLASMIC_EMAIL!,
      password: process.env.PLASMIC_PASSWORD!,
      userAgent: process.env.PLASMIC_USER_AGENT,
    });
    const created = (await client.post("/api/v1/projects", {
      name: `canvas-live-test-${new Date().toISOString().slice(0, 16)}`,
    })) as { project?: { id?: string }; projectId?: string; id?: string };
    projectId = created.project?.id ?? created.projectId ?? created.id!;
    expect(projectId).toBeTruthy();
    const needed = new Set(Object.values(TEMPLATES).flatMap((t) => t.tokensUsed));
    for (const t of DS_TOKENS.filter((t) => needed.has(t.varName))) {
      await client.post(`/api/v1/projects/${projectId}/tokens`, {
        name: t.name,
        type: t.type,
        value: t.value,
      });
    }
  }, 120_000);

  afterAll(async () => {
    if (projectId) await client.delete(`/api/v1/projects/${projectId}`);
  }, 60_000);

  it(
    "inserts raw HTML into an empty project by creating a page via Studio",
    async () => {
      const r = await insertHtmlOp(client, {
        projectId,
        html: '<div style="display: flex; flex-direction: column;"><h1>Raw case</h1></div>',
        newPageName: "LiveRaw",
      });
      expect(r.success).toBe(true);
      expect(r.method).toBe("paste");
      expect(r.createdPage).toBe(true);
      expect(r.page.name).toBe("LiveRaw");
      expect(r.modelNodesAdded).toBeGreaterThanOrEqual(1);
      expect(r.revisionAfter).toBeGreaterThan(r.revisionBefore);
    },
    180_000
  );

  for (const name of Object.keys(TEMPLATES)) {
    it(
      `inserts template ${name} with REST-verified node delta`,
      async () => {
        const html = renderTemplate(name, SAMPLE_PARAMS[name]);
        const r = await insertHtmlOp(client, { projectId, html });
        expect(r.success).toBe(true);
        expect(r.method).toBe("paste");
        expect(r.modelNodesAdded).toBeGreaterThanOrEqual(1);
        expect(r.tplNodesAdded).toBeGreaterThanOrEqual(1);
        expect(r.revisionAfter).toBeGreaterThan(r.revisionBefore);
      },
      180_000
    );
  }

  it(
    "binds var(--token-*) refs to real project token uuids",
    async () => {
      const { model } = await fetchRev(client, projectId);
      const tokensRes = (await client.get(`/api/v1/projects/${projectId}/tokens`)) as {
        tokens?: Array<{ uuid: string; name: string }>;
      };
      const uuids = new Set((tokensRes.tokens ?? []).map((t) => t.uuid));
      let bound = 0;
      const unbound: string[] = [];
      for (const node of Object.values(model.map)) {
        const values = (node as { values?: Record<string, string> }).values;
        if (!values) continue;
        for (const v of Object.values(values)) {
          if (typeof v !== "string") continue;
          for (const m of v.matchAll(/var\(--token-([^)]+)\)/g)) {
            if (uuids.has(m[1])) bound++;
            else unbound.push(m[0]);
          }
        }
      }
      expect(bound).toBeGreaterThan(0);
      expect(unbound).toEqual([]);
    },
    60_000
  );
});
