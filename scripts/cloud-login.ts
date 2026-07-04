/**
 * Mint/refresh a Playwright storage-state for Plasmic CLOUD (studio.plasmic.app)
 * from credentials in .env — the headless replacement for the interactive
 * "log in once on :9222" dance. The canvas StudioDriver picks the file up via
 * PLASMIC_STORAGE_STATE (src/browser/driver.ts).
 *
 *   npm run cloud:login
 *
 * Env (all in the local gitignored .env; values live in the ClickUp
 * passwords/links doc — never commit or print them):
 *   PLASMIC_CLOUD_EMAIL      login email
 *   PLASMIC_CLOUD_PASSWORD   login password
 *   PLASMIC_CLOUD_HOST       optional, default https://studio.plasmic.app
 *   PLASMIC_STORAGE_STATE    optional output path, default .plasmic/cloud-state.json
 */
import "dotenv/config";
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const host = process.env.PLASMIC_CLOUD_HOST ?? "https://studio.plasmic.app";
const email = process.env.PLASMIC_CLOUD_EMAIL;
const password = process.env.PLASMIC_CLOUD_PASSWORD;
const outPath = resolve(
  process.env.PLASMIC_STORAGE_STATE ?? ".plasmic/cloud-state.json"
);

if (!email || !password) {
  console.error(
    "PLASMIC_CLOUD_EMAIL / PLASMIC_CLOUD_PASSWORD missing from the environment. " +
      "Add them to .env (values: ClickUp passwords/links doc, studio.plasmic.app row)."
  );
  process.exit(1);
}

const mask = (s: string) => `${s.slice(0, 2)}…${s.slice(s.indexOf("@"))}`;

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: process.env.PLASMIC_USER_AGENT,
  });
  const page = await context.newPage();

  console.log(`logging in to ${host} as ${mask(email)} …`);
  await page.goto(`${host}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60_000 }),
    page.press('input[name="password"]', "Enter"),
  ]);

  // Verify the session actually works before persisting it.
  const self = await context.request.get(`${host}/api/v1/auth/self`);
  if (!self.ok()) {
    console.error(`login did not yield a working session: /auth/self → ${self.status()}`);
    process.exit(1);
  }
  const body = (await self.json()) as { user?: { email?: string } };
  if (body?.user?.email?.toLowerCase() !== email.toLowerCase()) {
    console.error(
      `unexpected /auth/self user: ${body?.user?.email ?? "(none)"} — not persisting`
    );
    process.exit(1);
  }

  mkdirSync(dirname(outPath), { recursive: true });
  await context.storageState({ path: outPath });
  console.log(`OK — session for ${mask(email)} saved to ${outPath}`);
  console.log(
    `point the driver at it: PLASMIC_STORAGE_STATE=${outPath} (add to .env). ` +
      "Re-run this script whenever the session expires."
  );
} finally {
  await browser.close();
}
