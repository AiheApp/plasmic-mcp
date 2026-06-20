import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { env, resolveProjectId } from "../env.js";
import { withStudioPage } from "../browser/session.js";
import {
  getCanvasState,
  selectElement,
  addElement,
  removeElement,
  setElementProps,
  moveElement,
  takeScreenshot,
  insertHtml,
  undo,
  studioFrameOf,
  type PropUpdate,
} from "../browser/canvas-ops.js";

const projectIdParam = z
  .string()
  .optional()
  .describe(
    `Plasmic project ID. Overrides PLASMIC_PROJECT_ID env var. ` +
    `The corresponding Studio tab must already be open in Chrome.`
  );

export function registerStudioBrowserTools(server: McpServer) {
  server.tool(
    "studio_get_canvas_state",
    "Read the current element tree and state from the open Plasmic Studio tab. " +
    "Requires Chrome to be running with --remote-debugging-port and the project open.",
    { projectId: projectIdParam },
    async ({ projectId }) => {
      const pid = resolveProjectId(projectId);
      const state = await withStudioPage(pid, (page) => getCanvasState(page));
      return { content: [{ type: "text" as const, text: JSON.stringify(state, null, 2) }] };
    }
  );

  server.tool(
    "studio_select_element",
    "Select an element by name in the Plasmic Studio Layers panel.",
    {
      projectId: projectIdParam,
      elementName: z.string().describe("Name of the element to select (as shown in the Layers panel)"),
    },
    async ({ projectId, elementName }) => {
      const pid = resolveProjectId(projectId);
      await withStudioPage(pid, (page) => selectElement(page, elementName));
      return { content: [{ type: "text" as const, text: `Selected element "${elementName}".` }] };
    }
  );

  server.tool(
    "studio_add_element",
    "Add an element to the canvas using the Plasmic Insert panel. " +
    "Optionally select a target slot/container first.",
    {
      projectId: projectIdParam,
      elementType: z.string().describe(
        'Type of element to insert. Examples: "Text", "Box", "Button", "Image", "Icon"'
      ),
      targetSlot: z
        .string()
        .optional()
        .describe("Name of the slot or container to insert into (selects it first)"),
    },
    async ({ projectId, elementType, targetSlot }) => {
      const pid = resolveProjectId(projectId);
      await withStudioPage(pid, (page) => addElement(page, elementType, targetSlot));
      return {
        content: [
          {
            type: "text" as const,
            text: `Added "${elementType}" element${targetSlot ? ` to slot "${targetSlot}"` : ""}.`,
          },
        ],
      };
    }
  );

  server.tool(
    "studio_remove_element",
    "Remove an element from the canvas. Selects it by name first if provided, " +
    "otherwise deletes the currently selected element.",
    {
      projectId: projectIdParam,
      elementName: z
        .string()
        .optional()
        .describe("Name of the element to remove. If omitted, removes the currently selected element."),
    },
    async ({ projectId, elementName }) => {
      const pid = resolveProjectId(projectId);
      await withStudioPage(pid, (page) => removeElement(page, elementName));
      return {
        content: [
          {
            type: "text" as const,
            text: elementName ? `Removed element "${elementName}".` : "Removed selected element.",
          },
        ],
      };
    }
  );

  server.tool(
    "studio_set_props",
    "Set properties or styles on a canvas element via the Plasmic right-side panel. " +
    "Selects the element by name first if provided.",
    {
      projectId: projectIdParam,
      elementName: z
        .string()
        .optional()
        .describe("Element to target. If omitted, applies to the currently selected element."),
      props: z
        .array(
          z.object({
            name: z.string().describe('Property name as shown in the panel, e.g. "color", "fontSize", "content"'),
            value: z.string().describe("New value to set"),
            tab: z
              .enum(["design", "content"])
              .optional()
              .describe('Panel tab to look in: "design" (default) or "content"'),
          })
        )
        .describe("List of prop/style updates to apply"),
    },
    async ({ projectId, elementName, props }) => {
      const pid = resolveProjectId(projectId);
      await withStudioPage(pid, (page) =>
        setElementProps(page, props as PropUpdate[], elementName)
      );
      return {
        content: [
          {
            type: "text" as const,
            text: `Applied ${props.length} prop update(s)${elementName ? ` to "${elementName}"` : ""}.`,
          },
        ],
      };
    }
  );

  server.tool(
    "studio_move_element",
    "Move an element up or down within its parent in the Plasmic Layers panel.",
    {
      projectId: projectIdParam,
      elementName: z.string().describe("Name of the element to move"),
      direction: z.enum(["up", "down"]).describe("Direction to move the element"),
      steps: z.number().optional().describe("Number of positions to move (default: 1)"),
    },
    async ({ projectId, elementName, direction, steps = 1 }) => {
      const pid = resolveProjectId(projectId);
      await withStudioPage(pid, (page) => moveElement(page, elementName, direction, steps));
      return {
        content: [
          {
            type: "text" as const,
            text: `Moved "${elementName}" ${direction} by ${steps} position(s).`,
          },
        ],
      };
    }
  );

  server.tool(
    "studio_screenshot",
    "Take a screenshot of the current Plasmic Studio state and return it as a base64 PNG.",
    { projectId: projectIdParam },
    async ({ projectId }) => {
      const pid = resolveProjectId(projectId);
      const base64 = await withStudioPage(pid, (page) => takeScreenshot(page));
      return {
        content: [
          {
            type: "image" as const,
            data: base64,
            mimeType: "image/png",
          },
        ],
      };
    }
  );

  server.tool(
    "studio_navigate",
    "Navigate the open Plasmic Studio tab to a specific component or page by name/path.",
    {
      projectId: projectIdParam,
      componentName: z
        .string()
        .optional()
        .describe("Component or page name to open in the Studio editor"),
    },
    async ({ projectId, componentName }) => {
      const pid = resolveProjectId(projectId);
      await withStudioPage(pid, async (page) => {
        if (componentName) {
          // Nav items are inside the studio-frame iframe, not the outer page
          const sf = studioFrameOf(page);
          const navItem = sf
            .locator(`[title="${componentName}"], [aria-label="${componentName}"], text="${componentName}"`)
            .first();
          const visible = await navItem.isVisible({ timeout: 3000 }).catch(() => false);
          if (visible) {
            await navItem.click();
            await page.waitForTimeout(500);
          }
        }
      });
      return {
        content: [
          {
            type: "text" as const,
            text: componentName
              ? `Navigated to "${componentName}" in Studio.`
              : "Studio page is active.",
          },
        ],
      };
    }
  );

  server.tool(
    "studio_insert_html",
    "Build a whole section at once: insert an HTML/CSS snippet onto the canvas " +
      "in one call (e.g. a hero, a login form, a pricing table). Pass a complete " +
      "HTML fragment starting with '<'; a <style> block is supported. A page or " +
      "component must be open in Studio. Returns a screenshot of the result.",
    {
      projectId: projectIdParam,
      html: z
        .string()
        .describe(
          "HTML to insert, starting with '<'. May include a leading <style>...</style> block."
        ),
    },
    async ({ projectId, html }) => {
      const pid = resolveProjectId(projectId);
      const base64 = await withStudioPage(pid, async (page) => {
        await insertHtml(page, html);
        return takeScreenshot(page);
      });
      return {
        content: [
          { type: "text" as const, text: "Inserted the section onto the canvas." },
          { type: "image" as const, data: base64, mimeType: "image/png" },
        ],
      };
    }
  );

  server.tool(
    "studio_undo",
    "Undo the last change on the Plasmic canvas (Cmd+Z). Returns a screenshot " +
      "of the result so you can confirm what was reverted.",
    { projectId: projectIdParam },
    async ({ projectId }) => {
      const pid = resolveProjectId(projectId);
      const base64 = await withStudioPage(pid, async (page) => {
        await undo(page);
        return takeScreenshot(page);
      });
      return {
        content: [
          { type: "text" as const, text: "Undid the last change." },
          { type: "image" as const, data: base64, mimeType: "image/png" },
        ],
      };
    }
  );
}
