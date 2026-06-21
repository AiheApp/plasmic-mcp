// canvas-smoke — one-command regression check for the canvas-browser MCP.
// Optionally quits Chrome first (true cold start), then: auto-launch Chrome ->
// authenticate -> open the project -> insert a section on a page -> screenshot.
// Run BEFORE shipping canvas-browser changes.
//
// Usage (from canvas-browser dir):
//   PLASMIC_STUDIO_HOST=https://studio.aihe.dev PLASMIC_EMAIL=.. PLASMIC_PASSWORD=.. \
//   PLASMIC_PROJECT_ID=.. SMOKE_PAGE="Demo Page" COLD=1 node workflows/canvas-smoke.mjs
// Env: COLD=1 quits Chrome first (cold start); SMOKE_PAGE = page to insert into; OUT = screenshot path.
import { execSync } from "child_process";
import { writeFileSync } from "fs";
import { withStudioPage } from "../dist/browser/session.js";
import { insertHtml } from "../dist/browser/canvas-ops.js";

const PID = process.env.PLASMIC_PROJECT_ID;
const SMOKE_PAGE = process.env.SMOKE_PAGE || "Demo Page";
const OUT = process.env.OUT || "/tmp/canvas-smoke.png";
const HTML = '<section style="padding:28px;background:#10b981;color:#fff;text-align:center;font-family:system-ui"><h2 style="margin:0">canvas-smoke OK</h2></section>';
if (!PID) { console.error("PLASMIC_PROJECT_ID required"); process.exit(1); }

if (process.env.COLD === "1") {
  try { execSync('pkill -i "Google Chrome"', { stdio: "ignore" }); } catch {}
  await new Promise(r => setTimeout(r, 4000));
  console.log("Chrome quit (cold start)");
}

const t0 = Date.now();
let ok = false;
await withStudioPage(PID, async (page) => {
  console.log("reached studio in", ((Date.now() - t0) / 1000).toFixed(0) + "s:", page.url().slice(0, 70));
  const sf = page.frameLocator("iframe.studio-frame").frameLocator("iframe.__wab_studio-frame");
  // wait until the target page component actually exists (cold studio populates components lazily)
  for (let i = 0; i < 60; i++) {
    const has = await sf.locator("body").evaluate((nm) => !!(window.dbg?.studioCtx?.site?.components || []).find(c => c.name === nm), SMOKE_PAGE).catch(() => false);
    if (has) break; await page.waitForTimeout(1000);
  }
  // switch to it, then wait until a focused ViewCtx is ready
  for (let i = 0; i < 20; i++) {
    await sf.locator("body").evaluate((nm) => { const c = (window.dbg.studioCtx.site.components || []).find(c => c.name === nm); if (c && window.dbg.studioCtx.switchToComponentArena) window.dbg.studioCtx.switchToComponentArena(c); }, SMOKE_PAGE).catch(() => {});
    await page.waitForTimeout(1500);
    const ready = await sf.locator("body").evaluate(() => !!(window.dbg.studioCtx.focusedOrFirstViewCtx && window.dbg.studioCtx.focusedOrFirstViewCtx())).catch(() => false);
    if (ready) break;
  }
  const nodes = () => sf.locator("body").evaluate((nm) => { const c = (window.dbg.studioCtx.site.components || []).find(c => c.name === nm); let n = 0; const w = t => { if (!t) return; n++; (t.children || []).forEach(w); }; try { w(c.tplTree); } catch {} return n; }, SMOKE_PAGE).catch(() => -1);
  const before = await nodes();
  let after = before;
  for (let k = 0; k < 4 && after <= before; k++) { try { await insertHtml(page, HTML); } catch (e) { console.log("  insert err:", (e.message || "").slice(0, 70)); } await page.waitForTimeout(2500); after = await nodes(); }
  ok = after > before;
  writeFileSync(OUT, await page.screenshot({ type: "png" }));
  console.log(`insert on "${SMOKE_PAGE}": ${before} -> ${after} (landed: ${ok}) | screenshot -> ${OUT}`);
});
console.log("SMOKE:", ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 2);
