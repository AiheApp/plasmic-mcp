/**
 * Frame-evaluated canvas operations against window.dbg.studioCtx.
 *
 * Everything here runs inside the Studio app frame via frame.evaluate. The
 * studioCtx surface used (site.components, switchToComponentArena,
 * focusedOrFirstViewCtx, paste, appCtx.appConfig) is the same one the Studio
 * client itself uses (platform/wab StudioCtx.tsx) and is exposed on
 * window.dbg in production builds.
 *
 * paste() is fed a DUCK-TYPED ReadableClipboard ({getText/getPlasmicData/
 * getImage}) — the paste router only calls those three methods, and a
 * guaranteed-string getText avoids the historical "e.trim is not a function"
 * footgun. HTML routes through pasteFromWebImporter, which is gated on the
 * allowHtmlPaste devflag (admin-team users on self-hosted); when the gate is
 * off we fall back to PLASMIC_AI_TOOLS.createComponent (Plasmic Cloud) rather
 * than let the router silently paste the markup as a text node.
 */
import type { Frame, Page } from "playwright";
import { CanvasError } from "./driver.js";

export interface PageTarget {
  uuid: string;
  name: string;
  path: string | null;
  frameCount: number;
}

export interface PasteOutcome {
  /**
   * True when the paste router reported success. StudioCtx.paste returns void
   * in current builds, so we read the router's side effect instead: it sets
   * focusedViewCtx().enforcePastingAsSibling = true ONLY on success (we clear
   * the flag before pasting).
   */
  pasteSucceeded: boolean;
  nodesBefore: number;
  nodesAfter: number;
  pasteError?: string;
  notifications: string[];
}

/**
 * Text of any visible blocking modal (e.g. "Code component no longer
 * registered" — a forced Replace/Delete decision that halts Studio load).
 * Used to turn opaque readiness timeouts into actionable BLOCKING_MODAL errors.
 */
export async function visibleModalText(frame: Frame): Promise<string | null> {
  try {
    return await frame.evaluate(() => {
      const modals = Array.from(
        document.querySelectorAll('.ant-modal, [role="dialog"], .ReactModal__Content')
      ).filter((m) => (m as HTMLElement).offsetParent !== null);
      const text = modals
        .map((m) => (m as HTMLElement).innerText?.trim())
        .filter(Boolean)
        .join(" | ");
      return text ? text.slice(0, 400) : null;
    });
  } catch {
    return null;
  }
}

/**
 * Poll briefly for a blocking modal. The doctor path never activates an arena
 * (whose readiness timeout is what normally flushes the modal out), so it
 * checks explicitly right after Studio load; the short window covers modals
 * that render a beat after studioCtx.site is ready.
 */
export async function detectBlockingModal(
  frame: Frame,
  timeoutMs = 3000
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const modal = await visibleModalText(frame);
    if (modal) return modal;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Wrap a readiness timeout in BLOCKING_MODAL if a modal is what's stalling Studio. */
async function throwReadinessError(
  frame: Frame,
  fallback: CanvasError
): Promise<never> {
  const modal = await visibleModalText(frame);
  if (modal) {
    throw new CanvasError(
      "BLOCKING_MODAL",
      `Studio is blocked by a modal that requires a manual decision: "${modal.slice(0, 200)}". ` +
        `Open the project in Studio and resolve it (often an unregistered code component — ` +
        `re-register it on the host app or delete its uses). See docs/canvas-runbook.md#blocking_modal.`,
      { ...fallback.diagnostics, modalText: modal }
    );
  }
  throw fallback;
}

/**
 * Resolve the target page (uuid | name | path; undefined → first page with
 * frames), switch to its dedicated arena, and wait until a ViewCtx for it is
 * live. Single evaluate with internal polling to minimize round trips.
 */
export async function ensurePageArena(
  frame: Frame,
  selector: string | undefined,
  timeoutMs: number
): Promise<PageTarget> {
  const res = (await frame.evaluate(
    async ({ selector, timeoutMs }) => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const w = window as any;
      const sc = w.dbg?.studioCtx;
      if (!sc?.site) return { ok: false as const, reason: "studioCtx.site not ready" };

      const comps: any[] = Array.from(sc.site.components);
      const pages = comps.filter((c) => !!c.pageMeta);
      const frameCountOf = (c: any): number => {
        try {
          const arena = sc.getDedicatedArena(c);
          const rows: any[] = arena?.matrix?.rows ?? [];
          return rows.reduce((n: number, r: any) => n + (r.cols?.length ?? 0), 0);
        } catch {
          return 0;
        }
      };

      let target: any;
      if (selector) {
        target =
          comps.find((c) => c.uuid === selector) ??
          pages.find((c) => c.name === selector) ??
          pages.find((c) => c.pageMeta?.path === selector);
        if (!target) {
          return {
            ok: false as const,
            reason: `no page matches "${selector}"`,
            pages: pages.map((p) => ({ uuid: p.uuid, name: p.name, path: p.pageMeta?.path ?? null })),
          };
        }
      } else {
        target = pages.find((p) => frameCountOf(p) > 0) ?? pages[0];
        if (!target) return { ok: false as const, reason: "project has no pages" };
      }

      const frameCount = frameCountOf(target);
      const info = {
        uuid: target.uuid as string,
        name: target.name as string,
        path: (target.pageMeta?.path ?? null) as string | null,
        frameCount,
      };
      if (frameCount === 0) return { ok: false as const, reason: "no-frame", ...info };

      sc.switchToComponentArena(target);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const vc = sc.focusedOrFirstViewCtx();
          if (vc && vc.currentTplComponent().component.uuid === target.uuid) {
            return { ok: true as const, ...info };
          }
        } catch {
          // arena still booting
        }
        await sleep(500);
      }
      return { ok: false as const, reason: "arena did not become ready", ...info };
    },
    { selector: selector ?? null, timeoutMs }
  )) as any;

  if (res.ok) return res as PageTarget;
  if (res.reason === "no-frame") {
    throw new CanvasError(
      "CANVAS_NO_FRAME",
      `page "${res.name}" (${res.uuid}) has no arena frames — it cannot receive a paste. ` +
        `Pages created via the REST model layer (plasmic_create_page) have empty ArenaFrameGrids; ` +
        `target a Studio-created page instead. See docs/canvas-runbook.md#canvas_no_frame.`,
      res
    );
  }
  if (res.reason === "project has no pages") {
    throw new CanvasError("CANVAS_NO_FRAME", "project has no pages", res);
  }
  if (typeof res.reason === "string" && res.reason.startsWith("no page matches")) {
    throw new CanvasError("PAGE_NOT_FOUND", res.reason, { pages: res.pages });
  }
  return throwReadinessError(
    frame,
    new CanvasError("CANVAS_NOT_READY", `target page arena not ready: ${res.reason}`, res)
  );
}

/**
 * Create a page through Studio's own flow (studioCtx.addComponent inside
 * sc.change) — unlike REST model-layer pages this seeds a real arena frame,
 * switches to it, and can receive pastes. Waits until its ViewCtx is live.
 */
export async function createPageInStudio(
  frame: Frame,
  name: string,
  timeoutMs: number
): Promise<PageTarget> {
  const res = (await frame.evaluate(
    async ({ name, timeoutMs }) => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const w = window as any;
      const sc = w.dbg?.studioCtx;
      if (!sc?.site) return { ok: false as const, reason: "studioCtx.site not ready" };
      let uuid: string | undefined;
      try {
        await sc.change(({ success }: { success: () => unknown }) => {
          const comp = sc.addComponent(name, { type: "page" });
          uuid = comp?.uuid;
          return success();
        });
      } catch (e: any) {
        return { ok: false as const, reason: `addComponent failed: ${e?.message ?? e}` };
      }
      if (!uuid) return { ok: false as const, reason: "addComponent returned no component" };

      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const vc = sc.focusedOrFirstViewCtx();
          if (vc && vc.currentTplComponent().component.uuid === uuid) {
            const comp = Array.from(sc.site.components).find((c: any) => c.uuid === uuid) as any;
            return {
              ok: true as const,
              uuid,
              name: comp.name as string,
              path: (comp.pageMeta?.path ?? null) as string | null,
              frameCount: 1,
            };
          }
        } catch {
          // arena still booting
        }
        await sleep(500);
      }
      return { ok: false as const, reason: "new page arena did not become ready", uuid };
    },
    { name, timeoutMs }
  )) as (PageTarget & { ok: true }) | { ok: false; reason: string };

  if (res.ok) return res;
  return throwReadinessError(
    frame,
    new CanvasError("CANVAS_NOT_READY", `could not create page in Studio: ${res.reason}`, res)
  );
}

/** Count tplTree descendants of a component (children-walk; the paste delta metric). */
export async function countPageNodes(frame: Frame, pageUuid: string): Promise<number> {
  return frame.evaluate((uuid) => {
    const w = window as any;
    const sc = w.dbg?.studioCtx;
    const comp = Array.from(sc?.site?.components ?? []).find((c: any) => c.uuid === uuid) as any;
    if (!comp?.tplTree) return -1;
    let n = 0;
    const stack = [comp.tplTree];
    while (stack.length) {
      const t: any = stack.pop();
      n++;
      for (const k of t.children ?? []) stack.push(k);
    }
    return n;
  }, pageUuid);
}

/** Is HTML paste available in this Studio session (allowHtmlPaste devflag)? */
export async function htmlPasteAllowed(frame: Frame): Promise<boolean> {
  return frame.evaluate(
    () => !!(window as any).dbg?.studioCtx?.appCtx?.appConfig?.allowHtmlPaste
  );
}

/**
 * One paste attempt via studioCtx.paste with a duck-typed clipboard. Returns
 * the router's boolean, before/after node counts, and any error notifications
 * that surfaced in the Studio UI (antd) for diagnostics.
 */
export async function pasteHtml(
  frame: Frame,
  pageUuid: string,
  html: string,
  settleMs = 1500
): Promise<PasteOutcome> {
  return (await frame.evaluate(
    async ({ pageUuid, html, settleMs }) => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const w = window as any;
      const sc = w.dbg.studioCtx;
      const count = () => {
        const comp = Array.from(sc.site.components).find((c: any) => c.uuid === pageUuid) as any;
        if (!comp?.tplTree) return -1;
        let n = 0;
        const stack = [comp.tplTree];
        while (stack.length) {
          const t: any = stack.pop();
          n++;
          for (const k of t.children ?? []) stack.push(k);
        }
        return n;
      };

      // Deterministic paste position: focus the page root and clear the
      // sibling-paste enforcement a previous successful paste leaves behind
      // (pasting "as sibling" of the root is rejected by Studio).
      try {
        const vc = sc.focusedOrFirstViewCtx();
        vc.enforcePastingAsSibling = false;
        vc.setStudioFocusByTpl(vc.tplUserRoot());
      } catch {
        // fall through — paste may still land via Studio's default focus
      }

      const nodesBefore = count();
      const clipboard = {
        getText: () => html,
        getPlasmicData: () => null,
        getImage: async () => null,
      };
      let pasteError: string | undefined;
      try {
        // Returns void in current builds — success is read from side effects.
        await sc.paste(clipboard);
      } catch (e: any) {
        pasteError = String(e?.message ?? e);
      }
      await sleep(settleMs);
      // The paste() wrapper sets this flag only when the router returned true.
      const pasteSucceeded =
        sc.focusedOrFirstViewCtx()?.enforcePastingAsSibling === true;
      const notifications = Array.from(
        document.querySelectorAll(
          ".ant-notification-notice-message, .ant-notification-notice-description"
        )
      )
        .map((el) => el.textContent?.trim() ?? "")
        // headless machines lack the project fonts; that notice is benign
        .filter((t) => t && !t.includes("is not available on this machine"))
        .filter((t) => !t.includes("won't be rendered correctly"));
      return { pasteSucceeded, nodesBefore, nodesAfter: count(), pasteError, notifications };
    },
    { pageUuid, html, settleMs }
  )) as PasteOutcome;
}

export interface AiToolsOutcome {
  available: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Plasmic Cloud path: window.PLASMIC_AI_TOOLS.createComponent (top frame).
 * Creates a NEW page from the HTML — used when the allowHtmlPaste gate is off
 * (cloud accounts are not Plasmic admin-team). identify() first, per protocol.
 */
export async function createComponentViaAiTools(
  page: Page,
  args: { projectId: string; name: string; html: string }
): Promise<AiToolsOutcome> {
  return (await page.mainFrame().evaluate(async (a) => {
    const tools = (window as any).PLASMIC_AI_TOOLS;
    if (!tools?.createComponent) return { available: false as const };
    try {
      await tools.identify?.({ client: "plasmic-mcp", skill: "insert_html" });
      const result = await tools.createComponent({
        projectId: a.projectId,
        name: a.name,
        type: "page",
        html: a.html,
      });
      return { available: true as const, result };
    } catch (e: any) {
      return { available: true as const, error: String(e?.message ?? e) };
    }
  }, args)) as AiToolsOutcome;
}

/** Presence probe for PLASMIC_AI_TOOLS on the top frame. */
export async function aiToolsAvailable(page: Page): Promise<boolean> {
  return page.mainFrame().evaluate(() => !!(window as any).PLASMIC_AI_TOOLS?.createComponent);
}

/**
 * Force-persist pending Studio changes: save() then poll hasUnsavedChanges.
 * Returns false if changes still pending after timeoutMs (caller must NOT
 * report success — the paste would be lost when the context closes).
 */
export async function flushSave(frame: Frame, timeoutMs = 15_000): Promise<boolean> {
  return frame.evaluate(async (timeoutMs) => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const sc = (window as any).dbg.studioCtx;
    const deadline = Date.now() + timeoutMs;
    try {
      await sc.save();
    } catch {
      // fall through to polling — the periodic saver may still flush
    }
    while (Date.now() < deadline) {
      try {
        if (!sc.hasUnsavedChanges()) return true;
      } catch {
        return true; // API drift: don't wedge; REST revision poll still gates success
      }
      await sleep(500);
      try {
        await sc.save();
      } catch {
        /* retried next loop */
      }
    }
    return false;
  }, timeoutMs);
}

export interface PageProbe {
  uuid: string;
  name: string;
  path: string | null;
  frameCount: number;
}

/** All pages with their arena frame counts (doctor surface). */
export async function listPagesWithFrames(frame: Frame): Promise<PageProbe[]> {
  return (await frame.evaluate(() => {
    const sc = (window as any).dbg.studioCtx;
    const pages = Array.from(sc.site.components).filter((c: any) => !!c.pageMeta) as any[];
    return pages.map((p) => {
      let frameCount = 0;
      try {
        const arena = sc.getDedicatedArena(p);
        const rows: any[] = arena?.matrix?.rows ?? [];
        frameCount = rows.reduce((n: number, r: any) => n + (r.cols?.length ?? 0), 0);
      } catch {
        /* count stays 0 */
      }
      return {
        uuid: p.uuid,
        name: p.name,
        path: p.pageMeta?.path ?? null,
        frameCount,
      };
    });
  })) as PageProbe[];
}
