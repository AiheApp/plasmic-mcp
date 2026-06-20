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
export function studioFrameOf(page) {
    return page
        .frameLocator("iframe.studio-frame")
        .frameLocator("iframe.__wab_studio-frame");
}
function studioFrame(page) {
    return studioFrameOf(page);
}
/** Wait for the Studio UI to be interactive (add-button visible in Studio SPA frame). */
async function waitForStudio(page, timeoutMs = 60_000) {
    // Wait for the outer wrapper iframe to exist first
    await page.waitForSelector("iframe.studio-frame", { timeout: timeoutMs });
    // Then wait for the Studio SPA's add-button — confirms the app is fully mounted
    await studioFrameOf(page)
        .locator('[data-test-id="add-button"]')
        .waitFor({ timeout: timeoutMs });
}
/** Save the current state via Ctrl/Cmd+S in the Studio frame. */
async function save(page) {
    await studioFrame(page).locator("body").press("Control+s");
    await page.waitForTimeout(600);
}
// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------
/**
 * Read current canvas state. window.dbg.studioCtx lives in the Studio SPA frame
 * (the same frame as the UI panels).
 */
export async function getCanvasState(page) {
    await waitForStudio(page);
    const raw = await studioFrame(page).locator("body").evaluate(() => {
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
export async function selectElement(page, elementName) {
    await waitForStudio(page);
    const sf = studioFrame(page);
    const leftPane = sf.locator(".canvas-editor__left-pane");
    await leftPane.waitFor({ timeout: 5_000 });
    const item = leftPane
        .locator(`[data-test-node-name="${elementName}"], text="${elementName}"`)
        .first();
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
 * Add an element to the canvas via the Plasmic add drawer.
 * elementType must match a [data-plasmic-add-item-name] value, e.g. "Text", "Box", "Button".
 */
export async function addElement(page, elementType, targetSlot) {
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
        throw new Error(`Insert item "${elementType}" not found (li[data-plasmic-add-item-name="${elementType}"]). ` +
            `Check the element type name matches what Plasmic shows in the add panel.`);
    }
    await item.click();
    await page.waitForTimeout(500);
    await save(page);
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
    await studioFrame(page).locator("body").press("Delete");
    await page.waitForTimeout(300);
    await save(page);
}
// ---------------------------------------------------------------------------
// Set props / styles
// ---------------------------------------------------------------------------
/** Set props or styles on an element via the Plasmic right-side panel. */
export async function setElementProps(page, props, elementName) {
    await waitForStudio(page);
    const sf = studioFrame(page);
    if (elementName) {
        await selectElement(page, elementName);
        await page.waitForTimeout(300);
    }
    const rightPanel = sf.locator(".canvas-editor__right-pane").first();
    const panelVisible = await rightPanel.isVisible({ timeout: 3_000 }).catch(() => false);
    if (!panelVisible) {
        throw new Error("Right panel (.canvas-editor__right-pane) not found. Is an element selected?");
    }
    for (const prop of props) {
        const tabName = prop.tab ?? "design";
        const tab = rightPanel.locator(`[role="tab"]:has-text("${tabName}")`).first();
        const tabVisible = await tab.isVisible({ timeout: 2_000 }).catch(() => false);
        if (tabVisible)
            await tab.click();
        const propRow = rightPanel
            .locator(`[data-plasmic-prop="${prop.name}"], label:has-text("${prop.name}")`)
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
    await save(page);
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
export async function takeScreenshot(page) {
    const buf = await page.screenshot({ type: "png" });
    return buf.toString("base64");
}
//# sourceMappingURL=canvas-ops.js.map