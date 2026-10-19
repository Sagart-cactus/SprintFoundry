import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeLandingPage } from "../../src/main.js";

describe("landing page interactions", () => {
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    document.body.innerHTML = `
      <nav></nav>
      <button class="nav-menu-btn" aria-expanded="false">Menu</button>
      <nav id="navMobile" hidden><a href="#features">Features</a></nav>
      <div class="code-block">
        <pre class="code-body">pnpm build</pre>
        <button class="code-copy" type="button">copy</button>
      </div>
    `;
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    vi.restoreAllMocks();
  });

  it("opens and closes the mobile navigation accessibly", () => {
    cleanup = initializeLandingPage();
    const menuButton = document.querySelector<HTMLButtonElement>(".nav-menu-btn");
    const mobileNavigation = document.getElementById("navMobile");

    expect(menuButton).not.toBeNull();
    expect(mobileNavigation?.hidden).toBe(true);
    menuButton?.click();
    expect(mobileNavigation?.hidden).toBe(false);
    expect(menuButton?.getAttribute("aria-expanded")).toBe("true");

    mobileNavigation?.querySelector("a")?.click();
    expect(mobileNavigation?.hidden).toBe(true);
    expect(menuButton?.getAttribute("aria-expanded")).toBe("false");
  });

  it("copies the code block and gives visible feedback", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    cleanup = initializeLandingPage();

    document.querySelector<HTMLButtonElement>(".code-copy")?.click();
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("pnpm build");
      expect(document.querySelector(".code-copy")?.textContent).toBe("copied!");
    });
  });
});
