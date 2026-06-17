// ---------------------------------------------------------------------------
// Frame helpers
// ---------------------------------------------------------------------------
/**
 * The outer Studio iframe — contains all Studio UI (panels, toolbar, canvas area).
 * All panel clicks, layer interactions, and keyboard shortcuts target this frame.
 * Exported as studioFrameOf for use in tool files.
 */
export function studioFrameOf(page) {
    return page.frameLocator("iframe.studio-frame");
}
function studioFrame(page) {
    return studioFrameOf(page);
}
/**
 * The inner canvas iframe nested inside the Studio frame.
 * window.dbg.studioCtx lives here. All JS evaluation of Plasmic internals
 * must run in this frame's context.
 */
function canvasFrame(page) {
    return page
        .frameLocator("iframe.studio-frame")
        .frameLocator("iframe.__wab_studio-frame");
}
/** Wait for the outer Studio iframe to appear, confirming the editor is loaded. */
async function waitForStudio(page, timeoutMs = 15_000) {
    await page.waitForSelector("iframe.studio-frame", { timeout: timeoutMs });
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
 * Read current canvas state via window.dbg.studioCtx inside the inner canvas iframe.
 * Evaluation must run in the nested iframe context — not page.evaluate().
 */
export async function getCanvasState(page) {
    await waitForStudio(page);
    const raw = await canvasFrame(page).locator("body").evaluate(() => {
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
    const layersText = await studioFrame(page)
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
    const sf = studioFrame(page);
    const leftPane = sf.locator(".canvas-editor__left-pane");
    await leftPane.waitFor({ timeout: 5_000 });
    // Try data-test-node-name attribute first, then plain text match
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
    // Click the + button to open the insert panel, then wait for the drawer
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
    // Keyboard events must target the Studio frame body — page.keyboard.press()
    // fires on the outer shell and never reaches the Studio iframe's event handlers.
    await studioFrame(page).locator("body").press("Delete");
    await page.waitForTimeout(300);
    await save(page);
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