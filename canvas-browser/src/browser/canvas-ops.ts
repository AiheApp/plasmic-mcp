import type { Page } from "playwright-core";

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wait for Plasmic Studio to finish loading (checks for the canvas iframe). */
async function waitForStudio(page: Page, timeoutMs = 15_000): Promise<void> {
  await page.waitForSelector('[data-testid="canvas-frame"], iframe[src*="plasmic"]', {
    timeout: timeoutMs,
  }).catch(() => {
    // Fallback: just wait for the page to stabilise
  });
  await page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => {});
}

/** Evaluate JavaScript in the Studio page context and return the result. */
async function evalInStudio<T>(page: Page, fn: () => T): Promise<T> {
  return page.evaluate(fn);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Read the current canvas state by probing Plasmic's internal globals.
 * Falls back to reading the accessibility tree if no internal API is found.
 */
export async function getCanvasState(page: Page): Promise<CanvasState> {
  await waitForStudio(page);

  const raw = await evalInStudio(page, () => {
    // Try Plasmic's internal editor state (varies by version)
    const win = window as unknown as Record<string, unknown>;

    // Attempt 1: window.__plasmicEditor
    if (win["__plasmicEditor"]) return { source: "__plasmicEditor", data: win["__plasmicEditor"] };

    // Attempt 2: window.plasmicStudio
    if (win["plasmicStudio"]) return { source: "plasmicStudio", data: win["plasmicStudio"] };

    // Attempt 3: walk React fiber from root to find component tree node
    const rootEl = document.querySelector("#plasmic-app") ?? document.querySelector("#root");
    if (rootEl) {
      const fiberKey = Object.keys(rootEl).find((k) => k.startsWith("__reactFiber"));
      if (fiberKey) {
        return { source: "fiber", data: "React fiber found — use studio_get_layers for structured data" };
      }
    }

    return { source: "none", data: null };
  });

  // Also read the Layers panel text content as a fallback readable tree
  const layersText = await page.locator('[data-testid="left-panel"], .left-panel, [aria-label*="Layer"]')
    .textContent({ timeout: 3000 })
    .catch(() => null);

  return {
    componentName: await page.title(),
    elements: [],
    raw: { internal: raw, layers: layersText },
  };
}

// ---------------------------------------------------------------------------
// Select
// ---------------------------------------------------------------------------

/** Select an element by name using the Layers panel search. */
export async function selectElement(page: Page, elementName: string): Promise<void> {
  await waitForStudio(page);

  // Try clicking the element in the Layers/Outline panel
  const layersPanel = page.locator('[data-testid="left-panel"], .left-panel').first();

  // Look for a tree item matching the element name
  const treeItem = layersPanel.locator(`[title="${elementName}"], text="${elementName}"`).first();
  const found = await treeItem.isVisible({ timeout: 3000 }).catch(() => false);

  if (found) {
    await treeItem.click();
    return;
  }

  // Fallback: try clicking on the canvas directly
  const canvasEl = page.locator(`[data-element-name="${elementName}"]`).first();
  const canvasFound = await canvasEl.isVisible({ timeout: 2000 }).catch(() => false);
  if (canvasFound) {
    await canvasEl.click();
    return;
  }

  throw new Error(`Element "${elementName}" not found in Layers panel or canvas.`);
}

// ---------------------------------------------------------------------------
// Add element
// ---------------------------------------------------------------------------

/**
 * Add an element to the canvas using the Insert panel.
 * elementType examples: "Text", "Button", "Box", "Image", "Icon"
 */
export async function addElement(
  page: Page,
  elementType: string,
  targetSlot?: string
): Promise<void> {
  await waitForStudio(page);

  // Select the target slot first if specified
  if (targetSlot) {
    await selectElement(page, targetSlot);
  }

  // Open the Insert panel (keyboard shortcut 'I' or click the + button)
  await page.keyboard.press("i");
  await page.waitForTimeout(400);

  // Try to find the insert panel / add panel
  const insertPanel = page.locator('[data-testid="insert-panel"], [aria-label*="Insert"], .insert-panel').first();
  const insertVisible = await insertPanel.isVisible({ timeout: 3000 }).catch(() => false);

  if (insertVisible) {
    // Search for the element type in the insert panel
    const searchInput = insertPanel.locator('input[type="search"], input[placeholder*="Search"]').first();
    const searchVisible = await searchInput.isVisible({ timeout: 2000 }).catch(() => false);
    if (searchVisible) {
      await searchInput.fill(elementType);
      await page.waitForTimeout(300);
    }

    // Click the matching element in the results
    const elementOption = insertPanel.locator(`text="${elementType}"`).first();
    const optionVisible = await elementOption.isVisible({ timeout: 3000 }).catch(() => false);
    if (optionVisible) {
      await elementOption.click();
      await page.waitForTimeout(500);
      return;
    }
  }

  // Fallback: use keyboard shortcut based on element type
  await page.keyboard.press("Escape");
  const shortcuts: Record<string, string> = {
    text: "t",
    box: "b",
    image: "m",
    button: "b",
  };
  const key = shortcuts[elementType.toLowerCase()];
  if (key) {
    await page.keyboard.press(key);
    await page.waitForTimeout(500);
    return;
  }

  throw new Error(`Could not add element "${elementType}". Try opening the Insert panel manually.`);
}

// ---------------------------------------------------------------------------
// Remove element
// ---------------------------------------------------------------------------

/** Remove an element from the canvas. Selects it first if elementName is given. */
export async function removeElement(page: Page, elementName?: string): Promise<void> {
  await waitForStudio(page);

  if (elementName) {
    await selectElement(page, elementName);
    await page.waitForTimeout(200);
  }

  await page.keyboard.press("Delete");
  await page.waitForTimeout(300);
}

// ---------------------------------------------------------------------------
// Set props / styles
// ---------------------------------------------------------------------------

export interface PropUpdate {
  /** Prop name as shown in the right panel, e.g. "color", "fontSize", "content" */
  name: string;
  value: string;
  /** Which panel tab to look in: "design" (default) or "content" */
  tab?: "design" | "content";
}

/**
 * Set props or styles on the currently selected element (or select it first).
 * Interacts with the right-side properties panel.
 */
export async function setElementProps(
  page: Page,
  props: PropUpdate[],
  elementName?: string
): Promise<void> {
  await waitForStudio(page);

  if (elementName) {
    await selectElement(page, elementName);
    await page.waitForTimeout(300);
  }

  const rightPanel = page.locator('[data-testid="right-panel"], .right-panel, [aria-label*="Properties"]').first();

  for (const prop of props) {
    // Switch to the correct tab
    const tabName = prop.tab ?? "design";
    const tab = rightPanel.locator(`[role="tab"]:has-text("${tabName}")`).first();
    const tabVisible = await tab.isVisible({ timeout: 2000 }).catch(() => false);
    if (tabVisible) await tab.click();

    // Find the input for this prop
    const propRow = rightPanel.locator(`[data-prop="${prop.name}"], label:has-text("${prop.name}")`).first();
    const propVisible = await propRow.isVisible({ timeout: 2000 }).catch(() => false);

    if (propVisible) {
      const input = propRow.locator('input, textarea').first();
      await input.fill(prop.value);
      await input.press("Enter");
    } else {
      // Try generic: find any input near a label matching the prop name
      const label = rightPanel.locator(`text="${prop.name}"`).first();
      const labelVisible = await label.isVisible({ timeout: 2000 }).catch(() => false);
      if (labelVisible) {
        const nearbyInput = label.locator(".. >> input, .. >> textarea").first();
        await nearbyInput.fill(prop.value);
        await nearbyInput.press("Enter");
      }
    }
    await page.waitForTimeout(200);
  }
}

// ---------------------------------------------------------------------------
// Move element
// ---------------------------------------------------------------------------

/** Move the selected element up or down in its parent's children list. */
export async function moveElement(
  page: Page,
  elementName: string,
  direction: "up" | "down",
  steps = 1
): Promise<void> {
  await waitForStudio(page);
  await selectElement(page, elementName);
  await page.waitForTimeout(200);

  // Plasmic uses Alt+ArrowUp / Alt+ArrowDown to reorder elements
  const key = direction === "up" ? "Alt+ArrowUp" : "Alt+ArrowDown";
  for (let i = 0; i < steps; i++) {
    await page.keyboard.press(key);
    await page.waitForTimeout(150);
  }
}

// ---------------------------------------------------------------------------
// Screenshot
// ---------------------------------------------------------------------------

/** Take a screenshot of the current Studio state and return as base64 PNG. */
export async function takeScreenshot(page: Page): Promise<string> {
  const buf = await page.screenshot({ type: "png" });
  return buf.toString("base64");
}
