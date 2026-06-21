import type { FrameLocator, Page } from "playwright-core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CanvasElement {
  id?: string;
  name: string;
  type: string;
  children?: CanvasElement[];
  props?: Record<string, unknown>;
}

export interface CanvasState {
  componentName: string;
  elements: CanvasElement[];
  raw?: unknown;
}

export interface PropUpdate {
  name: string;
  value: string;
  tab?: "design" | "content";
}

// ---------------------------------------------------------------------------
// Frame helpers
// ---------------------------------------------------------------------------

/**
 * The Plasmic Studio SPA is nested two levels deep inside the outer page:
 *
 *   studio.aihe.dev (outer page)
 *     └── iframe.studio-frame  →  canvas.aihe.dev/#origin=...  (thin wrapper)
 *          └── iframe.__wab_studio-frame  →  canvas.aihe.dev/  (ACTUAL Studio SPA)
 *               └── artboard preview iframes ...
 *
 * All Studio UI elements (panels, toolbar, add-button, keyboard handlers) and
 * window.dbg.studioCtx live in the innermost frame. The outer iframe.studio-frame
 * wrapper has no UI content.
 *
 * VERIFIED on Plasmic Cloud (studio.plasmic.app) 2026-06-21: the SAME two-level
 * chain resolves there too — `studio-frame > __wab_studio-frame` reaches both the
 * add-button and window.dbg.studioCtx.paste. So this works for self-hosted AND
 * cloud; only PLASMIC_STUDIO_HOST needs to point at the right origin.
 */
export function studioFrameOf(page: Page): FrameLocator {
  return page
    .frameLocator("iframe.studio-frame")
    .frameLocator("iframe.__wab_studio-frame");
}

// Candidate frame chains, primary first. The two-level chain works on both
// self-hosted and cloud; the single-level fallbacks add resilience if a future
// Studio/cloud DOM nests differently. resolveStudioFrame() picks the first whose
// body actually exposes window.dbg.studioCtx and caches the choice per page.
const STUDIO_FRAME_CHAINS: Array<(page: Page) => FrameLocator> = [
  (p) => p.frameLocator("iframe.studio-frame").frameLocator("iframe.__wab_studio-frame"),
  (p) => p.frameLocator("iframe.__wab_studio-frame"),
  (p) => p.frameLocator("iframe.studio-frame"),
];
const resolvedChain = new WeakMap<Page, number>();

/**
 * Resolve the FrameLocator that actually hosts window.dbg.studioCtx, probing the
 * known chains and caching the winner. Falls back to the primary chain (so a
 * caller's preflight surfaces a clear, plain-English error rather than this
 * throwing). Topology-agnostic across self-hosted and cloud.
 */
async function resolveStudioFrame(page: Page): Promise<FrameLocator> {
  const cached = resolvedChain.get(page);
  if (cached !== undefined) return STUDIO_FRAME_CHAINS[cached](page);
  for (let i = 0; i < STUDIO_FRAME_CHAINS.length; i++) {
    const fl = STUDIO_FRAME_CHAINS[i](page);
    const ok = await fl
      .locator("body")
      .evaluate(() => {
        const dbg = (window as unknown as Record<string, unknown>)["dbg"] as
          | { studioCtx?: unknown }
          | undefined;
        return !!(dbg && dbg.studioCtx);
      })
      .catch(() => false);
    if (ok) {
      resolvedChain.set(page, i);
      return fl;
    }
  }
  return STUDIO_FRAME_CHAINS[0](page);
}

function studioFrame(page: Page): FrameLocator {
  // Use the chain resolveStudioFrame() cached for this page (populated by
  // waitForStudio); default to the primary two-level chain otherwise. This lets
  // every helper transparently follow the resolved frame on both self-hosted and
  // cloud without each call site needing to be async.
  const cached = resolvedChain.get(page);
  return STUDIO_FRAME_CHAINS[cached ?? 0](page);
}

/** Wait for the Studio UI to be interactive (add-button visible in Studio SPA frame). */
async function waitForStudio(page: Page, timeoutMs = 60_000): Promise<void> {
  // Wait for the outer wrapper iframe to exist first
  await page.waitForSelector("iframe.studio-frame", { timeout: timeoutMs });
  // Then wait for the Studio SPA's add-button — confirms the app is fully mounted
  await studioFrameOf(page)
    .locator('[data-test-id="add-button"]')
    .waitFor({ timeout: timeoutMs });
  // Studio is mounted — resolve & cache the frame chain that hosts studioCtx so
  // every subsequent studioFrame() call follows it (self-hosted or cloud).
  await resolveStudioFrame(page);
}

/** Save the current state via Ctrl/Cmd+S in the Studio frame. */
async function save(page: Page): Promise<void> {
  await studioFrame(page).locator("body").press("Control+s");
  await page.waitForTimeout(600);
}

/**
 * Returns the Studio's window.dbg.studioCtx-derived focus state, used to give
 * designers plain-English guidance instead of a Playwright stack trace.
 */
async function focusState(
  page: Page
): Promise<{ ready: boolean; hasComponentOpen: boolean }> {
  try {
    const raw = await studioFrame(page)
      .locator("body")
      .evaluate(() => {
        const dbg = (window as unknown as Record<string, unknown>)["dbg"] as
          | { studioCtx?: Record<string, unknown> }
          | undefined;
        if (!dbg?.studioCtx) return { ready: false, hasComponentOpen: false };
        const ctx = dbg.studioCtx;
        const vc =
          typeof ctx["focusedOrFirstViewCtx"] === "function"
            ? (ctx["focusedOrFirstViewCtx"] as () => unknown)()
            : null;
        return { ready: true, hasComponentOpen: !!vc };
      });
    return raw as { ready: boolean; hasComponentOpen: boolean };
  } catch {
    return { ready: false, hasComponentOpen: false };
  }
}

/**
 * Preflight a mutating canvas action. Throws a plain-English, designer-facing
 * error (never a raw Playwright/stack error) when the canvas isn't ready.
 */
export async function preflightCanvas(page: Page): Promise<void> {
  try {
    await waitForStudio(page, 60_000);
  } catch {
    throw new Error(
      "Plasmic Studio isn't loaded yet. Open your project in Chrome and wait " +
        "for the canvas to appear, then try again."
    );
  }
}

/** Undo the last change via Ctrl/Cmd+Z in the Studio frame. */
export async function undo(page: Page): Promise<void> {
  await preflightCanvas(page);
  // Mac uses Cmd+Z; the Studio runs in the user's local Chrome on macOS.
  await studioFrame(page).locator("body").press("Meta+z");
  await page.waitForTimeout(400);
}

/**
 * Insert a full HTML/CSS section onto the canvas in one shot — the high-level
 * "build me a section" verb for designers. Drives Plasmic's web-importer the
 * same way a paste does: the Studio paste handler reads the clipboard text and
 * passes anything starting with "<" through htmlToTpl.
 *
 * Requires a frame/component to be open (preflight surfaces a plain-English
 * error otherwise). Returns nothing; callers should screenshot to confirm.
 */
export async function insertHtml(page: Page, html: string): Promise<void> {
  await preflightCanvas(page);

  const trimmed = html.trim();
  if (!trimmed.startsWith("<")) {
    throw new Error(
      "insertHtml expects an HTML snippet starting with '<' (e.g. " +
        "\"<div>...</div>\" or \"<style>...</style><div>...</div>\")."
    );
  }

  const sf = studioFrame(page);

  // Ensure a frame is open/focused; Studio's paste handler needs a ViewCtx and
  // requires the canvas (document.body) to be the active element.
  const state = await sf.locator("body").evaluate((_el) => {
    const dbg = (window as unknown as Record<string, unknown>)["dbg"] as
      | { studioCtx?: Record<string, unknown> }
      | undefined;
    const ctx = dbg?.studioCtx;
    const focused =
      typeof ctx?.["focusedViewCtx"] === "function"
        ? (ctx["focusedViewCtx"] as () => unknown)()
        : null;
    const firstVc =
      typeof ctx?.["focusedOrFirstViewCtx"] === "function"
        ? (ctx["focusedOrFirstViewCtx"] as () => unknown)()
        : null;
    return { hasViewCtx: !!(focused ?? firstVc) };
  }).catch(() => ({ hasViewCtx: false }));

  if (!state.hasViewCtx) {
    throw new Error(
      "No frame is open to receive the section. Open a page or component in " +
        "Studio (or select a frame), then try again."
    );
  }

  // Call studioCtx.paste() directly with a mock ReadableClipboard. This is the
  // same paste router the Studio uses, but bypasses the keyboard/clipboard-event
  // path (which is guarded by isFocusedOnCanvas + blocked by the cross-origin
  // iframe clipboard restriction). The router reads getText() and routes
  // "<"-prefixed text through the web-importer (htmlToTpl) — the path the
  // copilot Apply uses. Requires allowHtmlPaste devflag (true on this instance).
  const result = await studioFrame(page).locator("body").evaluate(async (_el, h) => {
    const dbg = (window as unknown as Record<string, unknown>)["dbg"] as
      | { studioCtx?: Record<string, unknown> }
      | undefined;
    const ctx = dbg?.studioCtx;
    if (!ctx || typeof ctx["paste"] !== "function") {
      return { ok: false, reason: "studioCtx.paste unavailable" };
    }
    const mockClipboard = {
      getPlasmicData: () => undefined,
      getText: () => h as string,
      getImage: () => Promise.resolve(undefined),
    };
    try {
      // Call as a method so `this` is bound to studioCtx (extracting the
      // function into a variable would lose `this` and silently no-op).
      await (ctx as unknown as { paste: (c: unknown) => Promise<unknown> }).paste(
        mockClipboard
      );
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: (e as Error)?.message?.slice(0, 160) ?? "paste failed" };
    }
  }, trimmed);

  if (!result.ok) {
    throw new Error(
      `Couldn't place the section on the canvas: ${result.reason}. ` +
        "Make sure a page or frame is open in Studio."
    );
  }

  await page.waitForTimeout(1200);
  await save(page);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Read current canvas state. window.dbg.studioCtx lives in the Studio SPA frame
 * (the same frame as the UI panels).
 */
export async function getCanvasState(page: Page): Promise<CanvasState> {
  await waitForStudio(page);

  const raw = await studioFrame(page).locator("body").evaluate(() => {
    const dbg = (window as unknown as Record<string, unknown>)["dbg"] as
      | { studioCtx?: Record<string, unknown> }
      | undefined;
    if (!dbg?.studioCtx) return { error: "window.dbg not available" };
    const ctx = dbg.studioCtx;
    try {
      return {
        currentComponent:
          (ctx["currentComponent"] as { name?: string } | null)?.name ?? null,
        focusedComponent:
          (
            typeof ctx["focusedViewCtx"] === "function"
              ? (ctx["focusedViewCtx"] as () => { component?: { name?: string } } | null)()
              : null
          )?.component?.name ?? null,
      };
    } catch (e) {
      return { error: String(e) };
    }
  }).catch(() => ({ error: "Studio frame not available" }));

  const layersText = await studioFrame(page)
    .locator(".canvas-editor__left-pane")
    .textContent({ timeout: 5_000 })
    .catch(() => null);

  return {
    componentName: await page.title(),
    elements: [],
    raw: { studioCtx: raw, layers: layersText },
  };
}

// ---------------------------------------------------------------------------
// Select
// ---------------------------------------------------------------------------

/** Select an element by name in the Plasmic Studio Layers panel. */
export async function selectElement(page: Page, elementName: string): Promise<void> {
  await waitForStudio(page);
  const sf = studioFrame(page);

  const leftPane = sf.locator(".canvas-editor__left-pane");
  const paneReady = await leftPane
    .waitFor({ timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!paneReady) {
    throw new Error(
      "The Layers panel isn't available — open a page or component in Studio first, then try again."
    );
  }

  const item = leftPane
    .locator(`[data-test-node-name="${elementName}"], text="${elementName}"`)
    .first();
  const found = await item.isVisible({ timeout: 3_000 }).catch(() => false);
  if (!found) {
    throw new Error(
      `Element "${elementName}" wasn't found in the Layers panel. Check the name matches a layer shown in Studio.`
    );
  }
  await item.click();
}

// ---------------------------------------------------------------------------
// Add element
// ---------------------------------------------------------------------------

/**
 * Add an element to the canvas via the Plasmic add drawer.
 * elementType must match a [data-plasmic-add-item-name] value, e.g. "Text", "Box", "Button".
 */
export async function addElement(
  page: Page,
  elementType: string,
  targetSlot?: string
): Promise<void> {
  await waitForStudio(page);
  const sf = studioFrame(page);

  if (targetSlot) {
    await selectElement(page, targetSlot);
    await page.waitForTimeout(300);
  }

  await sf.locator('[data-test-id="add-button"]').click();
  await sf.locator('[data-test-id="add-drawer"]').waitFor({ timeout: 5_000 });
  await page.waitForTimeout(200);

  const item = sf.locator(`li[data-plasmic-add-item-name="${elementType}"]`).first();
  const found = await item.isVisible({ timeout: 5_000 }).catch(() => false);
  if (!found) {
    throw new Error(
      `Insert item "${elementType}" not found (li[data-plasmic-add-item-name="${elementType}"]). ` +
        `Check the element type name matches what Plasmic shows in the add panel.`
    );
  }
  await item.click();
  await page.waitForTimeout(500);

  await save(page);
}

// ---------------------------------------------------------------------------
// Remove element
// ---------------------------------------------------------------------------

/** Delete an element from the canvas. Selects it by name first if provided. */
export async function removeElement(page: Page, elementName?: string): Promise<void> {
  await waitForStudio(page);
  if (elementName) {
    await selectElement(page, elementName);
    await page.waitForTimeout(200);
  }
  await studioFrame(page).locator("body").press("Delete");
  await page.waitForTimeout(300);

  await save(page);
}

// ---------------------------------------------------------------------------
// Set props / styles
// ---------------------------------------------------------------------------

/** Set props or styles on an element via the Plasmic right-side panel. */
export async function setElementProps(
  page: Page,
  props: PropUpdate[],
  elementName?: string
): Promise<void> {
  await waitForStudio(page);
  const sf = studioFrame(page);

  if (elementName) {
    await selectElement(page, elementName);
    await page.waitForTimeout(300);
  }

  const rightPanel = sf.locator(".canvas-editor__right-pane").first();
  const panelVisible = await rightPanel.isVisible({ timeout: 3_000 }).catch(() => false);
  if (!panelVisible) {
    throw new Error(
      "Right panel (.canvas-editor__right-pane) not found. Is an element selected?"
    );
  }

  for (const prop of props) {
    const tabName = prop.tab ?? "design";
    const tab = rightPanel.locator(`[role="tab"]:has-text("${tabName}")`).first();
    const tabVisible = await tab.isVisible({ timeout: 2_000 }).catch(() => false);
    if (tabVisible) await tab.click();

    const propRow = rightPanel
      .locator(`[data-plasmic-prop="${prop.name}"], label:has-text("${prop.name}")`)
      .first();
    const propVisible = await propRow.isVisible({ timeout: 2_000 }).catch(() => false);

    if (propVisible) {
      const input = propRow.locator("input, textarea").first();
      await input.fill(prop.value);
      await input.press("Enter");
    } else {
      const label = rightPanel.locator(`text="${prop.name}"`).first();
      const labelVisible = await label.isVisible({ timeout: 2_000 }).catch(() => false);
      if (!labelVisible) {
        throw new Error(
          `Prop "${prop.name}" not found in the right panel. Is the element selected?`
        );
      }
      const nearbyInput = label.locator(".. >> input, .. >> textarea").first();
      await nearbyInput.fill(prop.value);
      await nearbyInput.press("Enter");
    }
    await page.waitForTimeout(200);
  }

  await save(page);
}

// ---------------------------------------------------------------------------
// Move element
// ---------------------------------------------------------------------------

/** Move an element up or down in its parent using Plasmic's keyboard shortcuts. */
export async function moveElement(
  page: Page,
  elementName: string,
  direction: "up" | "down",
  steps = 1
): Promise<void> {
  await waitForStudio(page);
  await selectElement(page, elementName);
  await page.waitForTimeout(200);

  const key = direction === "up" ? "Alt+ArrowUp" : "Alt+ArrowDown";
  const sf = studioFrame(page);
  for (let i = 0; i < steps; i++) {
    await sf.locator("body").press(key);
    await page.waitForTimeout(150);
  }

  await save(page);
}

// ---------------------------------------------------------------------------
// Screenshot
// ---------------------------------------------------------------------------

/** Take a screenshot of the current Studio state and return as base64 PNG. */
export async function takeScreenshot(page: Page): Promise<string> {
  const buf = await page.screenshot({ type: "png" });
  return buf.toString("base64");
}
