import type { FrameLocator, Page } from "playwright-core";
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
export declare function studioFrameOf(page: Page): FrameLocator;
/**
 * Read current canvas state. window.dbg.studioCtx lives in the Studio SPA frame
 * (the same frame as the UI panels).
 */
export declare function getCanvasState(page: Page): Promise<CanvasState>;
/** Select an element by name in the Plasmic Studio Layers panel. */
export declare function selectElement(page: Page, elementName: string): Promise<void>;
/**
 * Add an element to the canvas via the Plasmic add drawer.
 * elementType must match a [data-plasmic-add-item-name] value, e.g. "Text", "Box", "Button".
 */
export declare function addElement(page: Page, elementType: string, targetSlot?: string): Promise<void>;
/** Delete an element from the canvas. Selects it by name first if provided. */
export declare function removeElement(page: Page, elementName?: string): Promise<void>;
/** Set props or styles on an element via the Plasmic right-side panel. */
export declare function setElementProps(page: Page, props: PropUpdate[], elementName?: string): Promise<void>;
/** Move an element up or down in its parent using Plasmic's keyboard shortcuts. */
export declare function moveElement(page: Page, elementName: string, direction: "up" | "down", steps?: number): Promise<void>;
/** Take a screenshot of the current Studio state and return as base64 PNG. */
export declare function takeScreenshot(page: Page): Promise<string>;
