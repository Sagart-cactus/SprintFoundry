const TICK_MS = 1_000;

function observeRevealElements(doc: Document, win: Window & typeof globalThis): () => void {
  const elements = doc.querySelectorAll<HTMLElement>(".reveal");
  const Observer = win.IntersectionObserver;

  if (typeof Observer !== "function") {
    elements.forEach((element) => element.classList.add("visible"));
    return () => undefined;
  }

  const observer = new Observer(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting && entry.target instanceof win.HTMLElement) {
          entry.target.classList.add("visible");
        }
      });
    },
    { threshold: 0.12, rootMargin: "0px 0px -40px 0px" },
  );

  elements.forEach((element) => observer.observe(element));
  return () => observer.disconnect();
}

async function copyCode(
  button: HTMLButtonElement,
  doc: Document = document,
  nav: Navigator = navigator,
): Promise<void> {
  const code = button.closest(".code-block")?.querySelector<HTMLPreElement>("pre.code-body");
  const clipboard = nav.clipboard;

  if (!code || !clipboard) return;

  try {
    await clipboard.writeText(code.innerText || code.textContent || "");
    button.textContent = "copied!";
    doc.defaultView?.setTimeout(() => {
      button.textContent = "copy";
    }, 2_000);
  } catch {
    button.textContent = "copy failed";
  }
}

export function initializeLandingPage(
  doc: Document = document,
  win: Window & typeof globalThis = window,
  nav: Navigator = navigator,
): () => void {
  const cleanups: Array<() => void> = [observeRevealElements(doc, win)];
  const intervals: number[] = [];

  let runSeconds = 4 * 60 + 12;
  intervals.push(
    win.setInterval(() => {
      runSeconds += 1;
      const minutes = String(Math.floor(runSeconds / 60)).padStart(2, "0");
      const seconds = String(runSeconds % 60).padStart(2, "0");
      const agent = doc.getElementById("monAgent1");

      if (agent) {
        agent.textContent = `Active: developer · claude-sonnet-4-5 · k8s-pod · 00:${minutes}:${seconds}`;
      }

      const progressBar = doc.getElementById("monBar1");
      if (progressBar instanceof win.HTMLElement) {
        const percent = Math.min(98, 57 + Math.floor(runSeconds / 30));
        progressBar.style.width = `${percent}%`;
      }

      if (runSeconds === 4 * 60 + 40) {
        const chips = doc.getElementById("monChips1");
        if (chips) {
          chips.innerHTML = `
            <span class="mon-chip done">product</span>
            <span class="mon-chip done">architect</span>
            <span class="mon-chip done">developer</span>
            <span class="mon-chip running">qa</span>
            <span class="mon-chip">security</span>`;
        }

        if (agent) {
          agent.textContent = "Active: qa · claude-sonnet-4-5 · k8s-pod · 00:00:03";
        }
        if (progressBar instanceof win.HTMLElement) {
          progressBar.style.width = "75%";
        }
        runSeconds = 0;
      }
    }, TICK_MS),
  );

  let refreshSeconds = 0;
  intervals.push(
    win.setInterval(() => {
      refreshSeconds += 1;
      const refreshLabel = doc.getElementById("monRefresh");
      if (!refreshLabel) return;

      refreshLabel.textContent =
        refreshSeconds < 60
          ? `refreshed ${refreshSeconds}s ago`
          : `refreshed ${Math.floor(refreshSeconds / 60)}m ago`;
    }, TICK_MS),
  );

  const onDocumentClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof win.Element)) return;

    const button = target.closest<HTMLButtonElement>(".code-copy");
    if (button) void copyCode(button, doc, nav);
  };
  doc.addEventListener("click", onDocumentClick);
  cleanups.push(() => doc.removeEventListener("click", onDocumentClick));

  const navigation = doc.querySelector<HTMLElement>("nav");
  const onScroll = (): void => {
    if (navigation) {
      navigation.style.background = win.scrollY > 60 ? "rgba(11,12,15,0.97)" : "rgba(11,12,15,0.85)";
    }
  };
  win.addEventListener("scroll", onScroll, { passive: true });
  cleanups.push(() => win.removeEventListener("scroll", onScroll));

  const menuButton = doc.querySelector<HTMLButtonElement>(".nav-menu-btn");
  const mobileNavigation = doc.getElementById("navMobile");
  if (menuButton && mobileNavigation) {
    const closeMobileMenu = (): void => {
      mobileNavigation.classList.remove("open");
      mobileNavigation.hidden = true;
      menuButton.setAttribute("aria-expanded", "false");
    };

    const onMenuClick = (): void => {
      const isOpen = mobileNavigation.classList.toggle("open");
      mobileNavigation.hidden = !isOpen;
      menuButton.setAttribute("aria-expanded", String(isOpen));
    };

    const onResize = (): void => {
      if (win.innerWidth > 900) closeMobileMenu();
    };

    menuButton.addEventListener("click", onMenuClick);
    mobileNavigation.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", closeMobileMenu);
    });
    win.addEventListener("resize", onResize);
    cleanups.push(() => {
      menuButton.removeEventListener("click", onMenuClick);
      mobileNavigation.querySelectorAll("a").forEach((link) => {
        link.removeEventListener("click", closeMobileMenu);
      });
      win.removeEventListener("resize", onResize);
    });
  }

  return () => {
    intervals.forEach((interval) => win.clearInterval(interval));
    cleanups.forEach((cleanup) => cleanup());
  };
}
