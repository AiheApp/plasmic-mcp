// plasmic-cloud-land — drop an HTML section onto a Plasmic CLOUD project as a new
// page, via the supported PLASMIC_AI_TOOLS path (identify -> createComponent+html).
// This is the "/plasmic-designer lands a component on cloud" capability, codified.
//
// Usage (run from the canvas-browser dir, or anywhere — paths are relative to this file):
//   CLOUD_EMAIL=admin@aihe.me CLOUD_PASS=... node workflows/plasmic-cloud-land.mjs <projectId> "<Page Name>" <htmlFile|->
// Env: CLOUD_HOST (default https://studio.plasmic.app), OUT (default /tmp/cloud-land.png)
import { chromium } from "playwright-core";
import { writeFileSync, readFileSync } from "fs";
import { exec } from "child_process";

const HOST = process.env.CLOUD_HOST || "https://studio.plasmic.app";
const EMAIL = process.env.CLOUD_EMAIL, PASS = process.env.CLOUD_PASS;
const OUT = process.env.OUT || "/tmp/cloud-land.png";
const [PROJ, PAGE, HTMLARG] = process.argv.slice(2);
if (!PROJ || !PAGE || !HTMLARG) { console.error("usage: plasmic-cloud-land.mjs <projectId> \"<Page Name>\" <htmlFile|->"); process.exit(1); }
if (!EMAIL || !PASS) { console.error("CLOUD_EMAIL and CLOUD_PASS required"); process.exit(1); }
const HTML = HTMLARG === "-" ? readFileSync(0, "utf8") : readFileSync(HTMLARG, "utf8");

const jar = new Map();
const store = r => { const raw = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : []; for (const l of raw) { const [nv] = l.split(";"); const e = nv.indexOf("="); if (e > 0) jar.set(nv.slice(0, e).trim(), nv.slice(e + 1).trim()); } };
const ch = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
const api = async (m, p, b, csrf) => { const h = { "content-type": "application/json", cookie: ch() }; if (csrf) h["x-csrf-token"] = csrf; const r = await fetch(`${HOST}${p}`, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined }); store(r); return r.json().catch(() => ({})); };
const r1 = await api("GET", "/api/v1/auth/csrf");
await api("POST", "/api/v1/auth/login", { email: EMAIL, password: PASS }, r1.csrf);
await api("GET", "/api/v1/auth/csrf");

let browser;
try { browser = await chromium.connectOverCDP("http://localhost:9222"); }
catch {
  exec(`open -na "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-studio-cdp "${HOST}/projects/${PROJ}"`, () => {});
  for (let i = 0; i < 20 && !browser; i++) { try { browser = await chromium.connectOverCDP("http://localhost:9222"); } catch { await new Promise(r => setTimeout(r, 800)); } }
  await new Promise(r => setTimeout(r, 8000));
}
const ctx = browser.contexts()[0];
await ctx.addCookies([...jar.entries()].map(([name, value]) => ({ name, value, domain: new URL(HOST).hostname, path: "/", secure: true, sameSite: "Lax" })));
for (const p of ctx.pages()) { if (p.url().includes(PROJ)) { try { await p.close(); } catch {} } }
const page = await ctx.newPage();
await page.goto(`${HOST}/projects/${PROJ}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(24000);

const aiFrame = async () => { for (const f of page.frames()) { if (await f.evaluate(() => !!(window.PLASMIC_AI_TOOLS && window.PLASMIC_AI_TOOLS.identify)).catch(() => false)) return f; } return null; };
const call = async (name, args) => {
  const f = await aiFrame(); if (!f) return { ok: false, err: "no AI frame" };
  let r = await f.evaluate(async ({ n, a }) => { try { return { ok: true, out: await window.PLASMIC_AI_TOOLS[n](a) }; } catch (e) { return { ok: false, err: (e.message || "").slice(0, 180) }; } }, { n: name, a: args }).catch(e => ({ ok: false, err: e.message.slice(0, 80) }));
  if (r.out && /identify\(\) once/.test(JSON.stringify(r.out)) && name !== "identify") {
    await (await aiFrame()).evaluate(() => window.PLASMIC_AI_TOOLS.identify({ model: "claude-opus-4-8", client: "plasmic-cloud-land", skill: "cloud-land" })).catch(() => {});
    r = await (await aiFrame()).evaluate(async ({ n, a }) => { try { return { ok: true, out: await window.PLASMIC_AI_TOOLS[n](a) }; } catch (e) { return { ok: false, err: (e.message || "").slice(0, 180) }; } }, { n: name, a: args }).catch(e => ({ ok: false, err: e.message.slice(0, 80) }));
  }
  await page.waitForTimeout(2000); return r;
};

await call("identify", { model: "claude-opus-4-8", client: "plasmic-cloud-land", skill: "cloud-land" });
const cr = await call("createComponent", { projectId: PROJ, name: PAGE, type: "page", html: HTML });
const landed = cr.out && cr.out.success && !/Failed to insert/.test(JSON.stringify(cr.out));
const uuid = (JSON.stringify(cr.out || "").match(/uuid=\\?"([^"\\]+)/) || [])[1];
console.log("createComponent:", landed ? "LANDED" : "FAILED", "uuid=" + (uuid || "?"));
console.log(JSON.stringify(cr.out || cr.err).slice(0, 200));
await page.waitForTimeout(2500);
writeFileSync(OUT, await page.screenshot({ type: "png" }));
console.log("screenshot ->", OUT);
await browser.close();
process.exit(landed ? 0 : 2);
