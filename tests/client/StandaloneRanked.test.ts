import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientEnv } from "../../src/client/ClientEnv";

vi.mock("../../src/client/LobbySocket", () => ({
  PublicLobbySocket: class {
    start(): void {}
    stop(): void {}
  },
}));

// Registers <game-mode-selector> as a side effect.
import "../../src/client/GameModeSelector";

type Selector = HTMLElement & { updateComplete: Promise<unknown> };

async function mount(standalone: boolean): Promise<Selector> {
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
  const selector = document.createElement("game-mode-selector") as Selector;
  document.body.appendChild(selector);
  await selector.updateComplete;
  return selector;
}

function labels(selector: Selector): string[] {
  return [...selector.querySelectorAll("button")].map(
    (b) => b.textContent ?? "",
  );
}

afterEach(() => {
  document.body.innerHTML = "";
  window.BOOTSTRAP_CONFIG = undefined;
  ClientEnv.reset();
});

// Ranked is matchmade by the account API, which a standalone server has none
// of. Create, Join and Solo are the server's own and stay.
describe("the Ranked button", () => {
  it("is not rendered on a standalone page", async () => {
    const selector = await mount(true);
    const all = labels(selector);
    expect(all.some((l) => l.includes("mode_selector.ranked_title"))).toBe(
      false,
    );
    expect(all.some((l) => l.includes("main.create"))).toBe(true);
    expect(all.some((l) => l.includes("main.join"))).toBe(true);
    expect(all.some((l) => l.includes("main.solo"))).toBe(true);
  });

  it("is rendered on a page that is not standalone", async () => {
    const selector = await mount(false);
    expect(
      labels(selector).some((l) => l.includes("mode_selector.ranked_title")),
    ).toBe(true);
  });
});
