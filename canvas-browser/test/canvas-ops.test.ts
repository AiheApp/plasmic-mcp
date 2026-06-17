import { describe, it, expect, vi, type Mock } from "vitest";

// ---------------------------------------------------------------------------
// Minimal Playwright mock surface
// ---------------------------------------------------------------------------

function makeLocator(overrides: Partial<ReturnType<typeof baseLocator>> = {}) {
  function baseLocator(): {
    locator: (s: string) => ReturnType<typeof baseLocator>;
    first: () => ReturnType<typeof baseLocator>;
    waitFor: Mock;
    isVisible: Mock;
    click: Mock;
    fill: Mock;
    press: Mock;
    textContent: Mock;
    evaluate: Mock;
  } {
    const self: ReturnType<typeof baseLocator> = {
      locator: (_s: string) => makeLocator(),
      first: () => self,
      waitFor: vi.fn().mockResolvedValue(undefined),
      isVisible: vi.fn().mockResolvedValue(true),
      click: vi.fn().mockResolvedValue(undefined),
      fill: vi.fn().mockResolvedValue(undefined),
      press: vi.fn().mockResolvedValue(undefined),
      textContent: vi.fn().mockResolvedValue("layer-text"),
      evaluate: vi.fn().mockResolvedValue({}),
      ...overrides,
    };
    return self;
  }
  return baseLocator();
}

function makeFrameLocator(locatorFactory?: (sel: string) => ReturnType<typeof makeLocator>) {
  const fl = {
    frameLocator: (_s: string) => makeFrameLocator(locatorFactory),
    locator: (sel: string) => locatorFactory ? locatorFactory(sel) : makeLocator(),
  };
  return fl;
}

function makePage(opts: {
  waitForSelectorOk?: boolean;
  studioCtxResult?: object;
  locatorFactory?: (sel: string) => ReturnType<typeof makeLocator>;
} = {}) {
  const frameLocatorImpl = makeFrameLocator(opts.locatorFactory);
  return {
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    title: vi.fn().mockResolvedValue("Test Studio"),
    screenshot: vi.fn().mockResolvedValue(Buffer.from("png-bytes")),
    frameLocator: (_sel: string) => frameLocatorImpl,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("canvas-ops: addElement uses add-button to open drawer", () => {
  it("clicks [data-test-id='add-button'] before looking for add-drawer", async () => {
    const clickedSelectors: string[] = [];

    const locatorFactory = (sel: string) => {
      const loc = makeLocator();
      loc.click = vi.fn(async () => { clickedSelectors.push(sel); });
      loc.waitFor = vi.fn().mockResolvedValue(undefined);
      loc.isVisible = vi.fn().mockResolvedValue(true);
      loc.locator = (s: string) => locatorFactory(s);
      loc.first = () => loc;
      loc.textContent = vi.fn().mockResolvedValue(null);
      loc.evaluate = vi.fn().mockResolvedValue({});
      return loc;
    };

    const page = makePage({ locatorFactory });

    const { addElement } = await import("../src/browser/canvas-ops.js");
    await addElement(page as never, "Text");

    expect(clickedSelectors).toContain('[data-test-id="add-button"]');
    // add-drawer should NOT be in the clicked list (it's waited on, not clicked)
    expect(clickedSelectors).not.toContain('[data-test-id="add-drawer"]');
  });
});

describe("canvas-ops: removeElement presses Delete in studioFrame body", () => {
  it("presses Delete on the studio-frame body, not the outer page", async () => {
    const pressedOn: string[] = [];

    const locatorFactory = (sel: string) => {
      const loc = makeLocator();
      loc.press = vi.fn(async (key: string) => { pressedOn.push(`${sel}::${key}`); });
      loc.waitFor = vi.fn().mockResolvedValue(undefined);
      loc.isVisible = vi.fn().mockResolvedValue(true);
      loc.click = vi.fn().mockResolvedValue(undefined);
      loc.textContent = vi.fn().mockResolvedValue(null);
      loc.locator = (s: string) => locatorFactory(s);
      loc.first = () => loc;
      loc.evaluate = vi.fn().mockResolvedValue({});
      return loc;
    };

    const page = makePage({ locatorFactory });

    const { removeElement } = await import("../src/browser/canvas-ops.js");
    await removeElement(page as never, "MyBox");

    expect(pressedOn.some((e) => e.includes("Delete"))).toBe(true);
  });
});

describe("canvas-ops: setElementProps uses data-plasmic-prop selector", () => {
  it("uses [data-plasmic-prop] not [data-prop]", async () => {
    const queriedSelectors: string[] = [];

    const locatorFactory = (sel: string) => {
      queriedSelectors.push(sel);
      const loc = makeLocator();
      loc.isVisible = vi.fn().mockResolvedValue(sel.includes("right-pane") ? true : false);
      loc.locator = (s: string) => locatorFactory(s);
      loc.first = () => loc;
      loc.waitFor = vi.fn().mockResolvedValue(undefined);
      loc.click = vi.fn().mockResolvedValue(undefined);
      loc.fill = vi.fn().mockResolvedValue(undefined);
      loc.press = vi.fn().mockResolvedValue(undefined);
      loc.textContent = vi.fn().mockResolvedValue(null);
      loc.evaluate = vi.fn().mockResolvedValue({});
      return loc;
    };

    const page = makePage({ locatorFactory });

    const { setElementProps } = await import("../src/browser/canvas-ops.js");
    await setElementProps(page as never, [{ name: "color", value: "red" }]).catch(() => {});

    const hasPlasmicProp = queriedSelectors.some((s) => s.includes("data-plasmic-prop"));
    const hasWrongDataProp = queriedSelectors.some(
      (s) => s.includes("data-prop=") && !s.includes("data-plasmic-prop")
    );

    expect(hasPlasmicProp).toBe(true);
    expect(hasWrongDataProp).toBe(false);
  });
});

describe("canvas-ops: getCanvasState evaluates in canvas iframe, not outer page", () => {
  it("calls evaluate on canvasFrame locator (nested iframe)", async () => {
    let evalCallCount = 0;

    // We need to track that evaluate() is called on a nested FrameLocator chain,
    // not on page.evaluate() directly. We do this by counting evaluate calls
    // on locators returned from frameLocator chains.
    const innerLocator = makeLocator({
      evaluate: vi.fn(async () => {
        evalCallCount++;
        return { currentComponent: "Root", focusedComponent: null };
      }),
    });
    const innerFrameLocator = {
      frameLocator: (_s: string) => innerFrameLocator,
      locator: (_s: string) => innerLocator,
    };
    const outerFrameLocator = {
      frameLocator: (_s: string) => innerFrameLocator,
      locator: (_s: string) => makeLocator({ textContent: vi.fn().mockResolvedValue("layers") }),
    };

    const page = {
      waitForSelector: vi.fn().mockResolvedValue(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      title: vi.fn().mockResolvedValue("Test Studio"),
      screenshot: vi.fn().mockResolvedValue(Buffer.from("")),
      frameLocator: (_s: string) => outerFrameLocator,
      evaluate: vi.fn(), // should NOT be called
    };

    const { getCanvasState } = await import("../src/browser/canvas-ops.js");
    const state = await getCanvasState(page as never);

    expect(evalCallCount).toBeGreaterThan(0);
    expect((page as typeof page & { evaluate: Mock }).evaluate).not.toHaveBeenCalled();
    expect(state.componentName).toBe("Test Studio");
  });
});
