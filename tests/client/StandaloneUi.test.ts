import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClientEnv } from "../../src/client/ClientEnv";

// The Ranked button lives in <game-mode-selector>, tested in
// StandaloneRanked.test.ts: registering it here would make every
// <play-page> below mount a real one.
// Each registers its custom element as a side effect.
import "../../src/client/components/DesktopNavBar";
import "../../src/client/components/MobileNavBar";
import "../../src/client/components/PlayPage";
import "../../src/client/components/PurchaseNudgeModal";
import "../../src/client/components/SteamWishlist";
import "../../src/client/components/SteamWishlistButton";
import {
  ACCOUNT_ONLY_PAGES,
  initNavigation,
} from "../../src/client/Navigation";

// jsdom has no ResizeObserver, and <steam-wishlist> constructs one on its
// first update.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

type Mountable = HTMLElement & { updateComplete: Promise<unknown> };

async function mount(tag: string): Promise<Mountable> {
  const el = document.createElement(tag) as Mountable;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

function setBootstrap(standalone: boolean) {
  window.BOOTSTRAP_CONFIG = {
    gameEnv: "prod",
    numWorkers: 1,
    turnstileSiteKey: "",
    jwtAudience: "example.com",
    instanceId: "test",
    gitCommit: "test",
    ...(standalone ? { standalone: true } : {}),
  };
  ClientEnv.reset();
}

const ACCOUNT_NAV_PAGES = [
  "page-item-store",
  "page-inventory",
  "page-leaderboard",
  "page-clan",
];

function navPages(root: ParentNode): string[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(".nav-menu-item[data-page]"),
  ).map((el) => el.dataset.page!);
}

afterEach(() => {
  document.body.innerHTML = "";
  window.BOOTSTRAP_CONFIG = undefined;
  ClientEnv.reset();
  localStorage.clear();
});

describe.each([
  ["standalone", true],
  ["not standalone", false],
])("account UI on a page that is %s", (_, standalone) => {
  beforeEach(() => {
    setBootstrap(standalone);
    window.currentPageId = "page-play";
  });

  it(`${standalone ? "drops" : "keeps"} Store, Inventory, Leaderboard and Clans on the desktop bar`, async () => {
    const bar = await mount("desktop-nav-bar");
    const pages = navPages(bar);
    expect(pages).toContain("page-play");
    for (const page of ACCOUNT_NAV_PAGES) {
      expect(pages.includes(page), page).toBe(!standalone);
    }
    expect(bar.querySelector("nav-account-menu") !== null).toBe(!standalone);
    // Settings and help stay either way.
    expect(bar.querySelector("nav-utility-icons")).not.toBeNull();
  });

  it(`${standalone ? "drops" : "keeps"} them on the mobile menu`, async () => {
    const bar = await mount("mobile-nav-bar");
    const pages = navPages(bar);
    expect(pages).toContain("page-play");
    for (const page of ACCOUNT_NAV_PAGES) {
      expect(pages.includes(page), page).toBe(!standalone);
    }
  });

  it(`${standalone ? "drops" : "keeps"} the mobile account menu and the Steam widget`, async () => {
    const page = await mount("play-page");
    expect(page.querySelector("nav-account-menu") !== null).toBe(!standalone);
    expect(page.querySelector("steam-wishlist") !== null).toBe(!standalone);
    expect(page.querySelector("nav-utility-icons")).not.toBeNull();
    expect(page.querySelector("game-mode-selector")).not.toBeNull();
  });

  it(`${standalone ? "renders nothing for" : "renders"} Buy on Steam`, async () => {
    const button = await mount("steam-wishlist-button");
    expect(button.querySelector("a") !== null).toBe(!standalone);
    const widget = await mount("steam-wishlist");
    expect(widget.querySelector("iframe") !== null).toBe(!standalone);
  });

  it(`${standalone ? "never shows" : "shows"} the store nudge to a long-time player`, async () => {
    localStorage.setItem("gamesPlayed", "51");
    const nudge = await mount("purchase-nudge-modal");
    document.dispatchEvent(
      new CustomEvent("userMeResponse", { detail: false }),
    );
    await nudge.updateComplete;
    expect(nudge.querySelector('[role="dialog"]') !== null).toBe(!standalone);
  });
});

describe("navigation on a standalone page", () => {
  beforeEach(() => {
    setBootstrap(true);
    window.currentPageId = "page-play";
    initNavigation();
  });

  afterEach(() => {
    delete window.showPage;
  });

  it.each([...ACCOUNT_ONLY_PAGES])("refuses %s", (pageId) => {
    window.showPage!(pageId);
    expect(window.currentPageId).toBe("page-play");
  });

  it("still opens settings and help", () => {
    window.showPage!("page-settings");
    expect(window.currentPageId).toBe("page-settings");
    window.showPage!("page-help");
    expect(window.currentPageId).toBe("page-help");
  });
});
