import type { Page } from "playwright-core";
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
/**
 * Read the current canvas state by probing Plasmic's internal globals.
 * Falls back to reading the accessibility tree if no internal API is found.
 */
export declare function getCanvasState(page: Page): Promise<CanvasState>;
/** Select an element by name using the Layers panel search. */
export declare function selectElement(page: Page, elementName: string): Promise<void>;
/**
 * Add an element to the canvas using the Insert panel.
 * elementType examples: "Text", "Button", "Box", "Image", "Icon"
 */
export declare function addElement(page: Page, elementType: string, targetSlot?: string): Promise<void>;
/** Remove an element from the canvas. Selects it first if elementName is given. */
export declare function removeElement(page: Page, elementName?: string): Promise<void>;
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
export declare function setElementProps(page: Page, props: PropUpdate[], elementName?: string): Promise<void>;
/** Move the selected element up or down in its parent's children list. */
export declare function moveElement(page: Page, elementName: string, direction: "up" | "down", steps?: number): Promise<void>;
/** Take a screenshot of the current Studio state and return as base64 PNG. */
export declare function takeScreenshot(page: Page): Promise<string>;
