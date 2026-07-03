/**
 * StudioDriver — Playwright lifecycle for canvas-browser operations.
 *
 * One headless Chromium per MCP process (lazy), a FRESH browser context per
 * operation (the memory-proven reliability recipe: stale Studio tabs make
 * paste flaky), authenticated by injecting the PlasmicClient session cookie
 * jar — no UI login.
 *
 * Playwright is imported lazily so REST-only deployments (e.g. the Docker
 * image) work without a browser install; canvas tools then fail with a
 * structured BROWSER_UNAVAILABLE error instead of crashing the server.
 */
import type { Browser, BrowserContext, Frame, Page } from "playwright";
import type { PlasmicClient } from "../client.js";

export type CanvasErrorKind =
  | "BROWSER_UNAVAILABLE"
  | "STUDIO_UNREACHABLE"
  | "CANVAS_NOT_READY"
  | "CANVAS_NO_FRAME"
  | "BLOCKING_MODAL"
  | "HTML_PASTE_DISABLED"
  | "PAGE_NOT_FOUND"
  | "PASTE_FAILED"
  | "PASTED_AS_TEXT"
  | "VERIFY_TIMEOUT"
  | "UNKNOWN_TOKENS"
  | "TEMPLATE_ERROR";

export class CanvasError extends Error {
  constructor(
    readonly kind: CanvasErrorKind,
    message: string,
    readonly diagnostics?: Record<string, unknown>
  ) {
    super(message);
    this.name = "CanvasError";
  }
}

export interface StudioSession {
  page: Page;
  /** Frame whose window.dbg.studioCtx is live (Studio app frame). */
  studioFrame: Frame;
  close(): Promise<void>;
}

interface FrameProbe {
  url: string;
  hasDbg: boolean;
  hasStudioCtx: boolean;
  siteReady: boolean;
  allowHtmlPaste?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class StudioDriver {
  private browser: Browser | undefined;
  private launching: Promise<Browser> | undefined;

  constructor(private readonly client: PlasmicClient) {}

  private async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (!this.launching) {
      this.launching = (async () => {
        let chromium: (typeof import("playwright"))["chromium"];
        try {
          ({ chromium } = await import("playwright"));
        } catch (e) {
          throw new CanvasError(
            "BROWSER_UNAVAILABLE",
            `playwright not installed (${(e as Error)?.message}). Run: npm i playwright && npx playwright install chromium`
          );
        }
        try {
          this.browser = await chromium.launch({ headless: true });
        } catch (e) {
          throw new CanvasError(
            "BROWSER_UNAVAILABLE",
            `chromium failed to launch: ${(e as Error)?.message}. Run: npx playwright install chromium`
          );
        }
        return this.browser;
      })();
      this.launching.catch(() => (this.launching = undefined));
    }
    const b = await this.launching;
    this.launching = undefined;
    return b;
  }

  private async newContext(): Promise<BrowserContext> {
    const browser = await this.getBrowser();
    const storageState = process.env.PLASMIC_STORAGE_STATE;
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      userAgent: process.env.PLASMIC_USER_AGENT,
      ...(storageState ? { storageState } : {}),
    });
    // When this package runs under tsx, esbuild's keepNames transform injects
    // __name() helper calls into the evaluate callbacks it serializes into the
    // page; define the helper there so those callbacks don't ReferenceError.
    await context.addInitScript({
      content: "globalThis.__name = globalThis.__name || ((fn) => fn);",
    });
    if (!storageState) {
      const url = new URL(this.client.host);
      const cookies = await this.client.getCookies();
      await context.addCookies(
        cookies.map(({ name, value }) => ({
          name,
          value,
          domain: url.hostname,
          path: "/",
          secure: url.protocol === "https:",
        }))
      );
    }
    return context;
  }

  /**
   * Open the Studio for a project and locate the frame owning
   * window.dbg.studioCtx with a ready site. Retries the whole navigation up
   * to `attempts` times with 1s/2s/4s backoff between attempts; within an
   * attempt, polls frames for `waitMs`.
   */
  async openStudio(
    projectId: string,
    opts: { waitMs?: number; attempts?: number } = {}
  ): Promise<StudioSession> {
    const waitMs = opts.waitMs ?? 15_000;
    const attempts = opts.attempts ?? 3;
    let lastProbes: FrameProbe[] = [];
    let lastError = "";

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const context = await this.newContext();
      const page = await context.newPage();
      try {
        await page.goto(`${this.client.host}/projects/${encodeURIComponent(projectId)}`, {
          waitUntil: "domcontentloaded",
          timeout: waitMs,
        });

        const deadline = Date.now() + waitMs;
        while (Date.now() < deadline) {
          lastProbes = await probeFrames(page);
          const hit = lastProbes.findIndex((p) => p.hasStudioCtx && p.siteReady);
          if (hit >= 0) {
            const studioFrame = page.frames()[hit];
            return { page, studioFrame, close: () => context.close() };
          }
          await sleep(500);
        }
        lastError = `studioCtx not ready within ${waitMs}ms`;
      } catch (e) {
        lastError = (e as Error)?.message ?? String(e);
      }
      await context.close().catch(() => {});
      if (attempt < attempts) await sleep(1000 * 2 ** (attempt - 1));
    }

    throw new CanvasError(
      "CANVAS_NOT_READY",
      `Studio canvas not ready for ${projectId} after ${attempts} attempts: ${lastError}`,
      { frames: lastProbes }
    );
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => {});
    this.browser = undefined;
  }
}

/** Evaluate every frame for window.dbg.studioCtx presence (order matches page.frames()). */
async function probeFrames(page: Page): Promise<FrameProbe[]> {
  return Promise.all(
    page.frames().map(async (f) => {
      try {
        return await f.evaluate(() => {
          const w = window as unknown as {
            dbg?: {
              studioCtx?: {
                site?: unknown;
                appCtx?: { appConfig?: { allowHtmlPaste?: boolean } };
              };
            };
          };
          return {
            url: location.href,
            hasDbg: !!w.dbg,
            hasStudioCtx: !!w.dbg?.studioCtx,
            siteReady: !!w.dbg?.studioCtx?.site,
            allowHtmlPaste: w.dbg?.studioCtx?.appCtx?.appConfig?.allowHtmlPaste,
          };
        });
      } catch {
        // Frame detached or not yet loaded — report as not ready.
        return { url: f.url(), hasDbg: false, hasStudioCtx: false, siteReady: false };
      }
    })
  );
}
