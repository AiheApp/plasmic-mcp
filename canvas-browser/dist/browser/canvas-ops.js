// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** Wait for the Plasmic Studio iframe to appear, confirming the editor is loaded. */
async function waitForStudio(page, timeoutMs = 15_000) {
    await page.waitForSelector("iframe.__wab_studio-frame", { timeout: timeoutMs });
}
/**
 * Get the inner Plasmic Studio iframe frame.
 * window.dbg.studioCtx and all Plasmic internal APIs live inside this frame.
 */
export async function getStudioFrame(page) {
    const iframe = page.locator("iframe.__wab_studio-frame").first();
    await iframe.waitFor({ timeout: 15_000 });
    const handle = await iframe.elementHandle();
    const frame = await handle?.contentFrame();
    if (!frame) {
        throw new Error("Could not access Plasmic Studio iframe. Is the project fully loaded?");
    }
    return frame;
}
// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------
/**
 * Read current canvas state via window.dbg.studioCtx inside the studio iframe.
 * Returns the active component name and focused component from Plasmic internals.
 */
export async function getCanvasState(page) {
    await waitForStudio(page);
    const frame = await getStudioFrame(page);
    const raw = await frame.evaluate(() => {
        // window.dbg.studioCtx is confirmed available in Plasmic's OSS build
        const dbg = window["dbg"];
        if (!dbg?.studioCtx)
            return { error: "window.dbg not available" };
        const ctx = dbg.studioCtx;
        try {
            return {
                currentComponent: ctx["currentComponent"]?.name ?? null,
                focusedComponent: (typeof ctx["focusedViewCtx"] === "function"
                    ? ctx["focusedViewCtx"]()
                    : null)?.component?.name ?? null,
            };
        }
        catch (e) {
            return { error: String(e) };
        }
    });
    // Also pull a text summary from the Layers panel for convenience
    const layersText = await page
        .locator(".canvas-editor__left-pane")
        .textContent({ timeout: 3_000 })
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
export async function selectElement(page, elementName) {
    await waitForStudio(page);
    const leftPane = page.locator(".canvas-editor__left-pane").first();
    await leftPane.waitFor({ timeout: 5_000 });
    const item = leftPane.locator(`text="${elementName}"`).first();
    const found = await item.isVisible({ timeout: 3_000 }).catch(() => false);
    if (!found) {
        throw new Error(`Element "${elementName}" not found in the Layers panel (.canvas-editor__left-pane).`);
    }
    await item.click();
}
// ---------------------------------------------------------------------------
// Add element
// ---------------------------------------------------------------------------
/**
 * Add an element to the canvas via the Plasmic add button.
 * elementType must match a [data-plasmic-add-item-name] value, e.g. "Text", "Box", "Button".
 */
export async function addElement(page, elementType, targetSlot) {
    await waitForStudio(page);
    if (targetSlot) {
        await selectElement(page, targetSlot);
        await page.waitForTimeout(300);
    }
    // Click the confirmed add button selector from Plasmic's test suite
    const addBtn = page.locator('[data-test-id="add-button"]').first();
    await addBtn.waitFor({ timeout: 5_000 });
    await addBtn.click();
    await page.waitForTimeout(400);
    // Click the element using the confirmed attribute from Plasmic's test suite
    const item = page
        .locator(`[data-plasmic-add-item-name="${elementType}"]`)
        .first();
    const found = await item.isVisible({ timeout: 5_000 }).catch(() => false);
    if (!found) {
        throw new Error(`Insert item "${elementType}" not found ([data-plasmic-add-item-name="${elementType}"]). ` +
            `Check the element type name matches what Plasmic shows in the add panel.`);
    }
    await item.click();
    await page.waitForTimeout(500);
}
// ---------------------------------------------------------------------------
// Remove element
// ---------------------------------------------------------------------------
/** Delete an element from the canvas. Selects it by name first if provided. */
export async function removeElement(page, elementName) {
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
/**
 * Set props or styles on an element via the Plasmic right-side panel.
 * Selects the element by name first if elementName is provided.
 */
export async function setElementProps(page, props, elementName) {
    await waitForStudio(page);
    if (elementName) {
        await selectElement(page, elementName);
        await page.waitForTimeout(300);
    }
    // Right panel — selector not confirmed; use broad fallback
    const rightPanel = page
        .locator(".right-pane, [class*='right-panel'], [class*='rightPane']")
        .first();
    const panelVisible = await rightPanel.isVisible({ timeout: 3_000 }).catch(() => false);
    if (!panelVisible) {
        throw new Error("Right panel not found. The selector may need updating for your Plasmic version.");
    }
    for (const prop of props) {
        const tabName = prop.tab ?? "design";
        const tab = rightPanel
            .locator(`[role="tab"]:has-text("${tabName}")`)
            .first();
        const tabVisible = await tab.isVisible({ timeout: 2_000 }).catch(() => false);
        if (tabVisible)
            await tab.click();
        // Try data-prop attribute first, then label proximity
        const propRow = rightPanel
            .locator(`[data-prop="${prop.name}"], label:has-text("${prop.name}")`)
            .first();
        const propVisible = await propRow.isVisible({ timeout: 2_000 }).catch(() => false);
        if (propVisible) {
            const input = propRow.locator("input, textarea").first();
            await input.fill(prop.value);
            await input.press("Enter");
        }
        else {
            const label = rightPanel.locator(`text="${prop.name}"`).first();
            const labelVisible = await label.isVisible({ timeout: 2_000 }).catch(() => false);
            if (!labelVisible) {
                throw new Error(`Prop "${prop.name}" not found in the right panel. Is the element selected?`);
            }
            const nearbyInput = label.locator(".. >> input, .. >> textarea").first();
            await nearbyInput.fill(prop.value);
            await nearbyInput.press("Enter");
        }
        await page.waitForTimeout(200);
    }
}
// ---------------------------------------------------------------------------
// Move element
// ---------------------------------------------------------------------------
/** Move an element up or down in its parent using Plasmic's keyboard shortcuts. */
export async function moveElement(page, elementName, direction, steps = 1) {
    await waitForStudio(page);
    await selectElement(page, elementName);
    await page.waitForTimeout(200);
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
export async function takeScreenshot(page) {
    const buf = await page.screenshot({ type: "png" });
    return buf.toString("base64");
}
//# sourceMappingURL=canvas-ops.js.map