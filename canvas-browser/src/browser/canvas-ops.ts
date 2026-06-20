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
 * All Studio UI elements (panels, toolbar, add-button, keyboard handlers) live in
 * the innermost frame. The outer iframe.studio-frame wrapper has no UI content.
 */
export function studioFrameOf(page: Page): FrameLocator {
  return page
    .frameLocator("iframe.studio-frame")
    .frameLocator("iframe.__wab_studio-frame");
}

function studioFrame(page: Page): FrameLocator {
  return studioFrameOf(page);
}

/** Wait for the Studio UI to be interactive (add-button visible in Studio SPA frame). */
async function waitForStudio(page: Page, timeoutMs = 60_000): Promise<void> {
  // Wait for the outer wrapper iframe to exist first
  await page.waitForSelector("iframe.studio-frame", { timeout: timeoutMs });
  // Then wait for the Studio SPA's add-button — confirms the app is fully mounted
  await studioFrameOf(page)
    .locator('[data-test-id="add-button"]')
    .waitFor({ timeout: timeoutMs });
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

  // Focus the canvas so the paste lands on the open frame.
  await sf.locator("body").click().catch(() => {});

  // Put the HTML on the clipboard as plain text. The Studio paste handler
  // (clipboard/paste.tsx) reads clipboard.getText() and routes "<"-prefixed
  // text to the web-importer. Requires clipboard permission on the context
  // (granted in session.ts).
  await sf.locator("body").evaluate(async (_el, h) => {
    await navigator.clipboard.writeText(h as string);
  }, trimmed);
  await page.waitForTimeout(200);

  // Paste (Cmd+V on macOS) → triggers htmlToTpl on the focused frame.
  await sf.locator("body").press("Meta+v");
  await page.waitForTimeout(1500);

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
  await leftPane.waitFor({ timeout: 5_000 });

  const item = leftPane
    .locator(`[data-test-node-name="${elementName}"], text="${elementName}"`)
    .first();
  const found = await item.isVisible({ timeout: 3_000 }).catch(() => false);
  if (!found) {
    throw new Error(
      `Element "${elementName}" not found in the Layers panel (.canvas-editor__left-pane).`
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
