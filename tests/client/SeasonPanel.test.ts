import { SEASON_CYCLE_TICKS } from "@openfront/engine-lib/game/Seasons";
import { SeasonPanel } from "../../src/client/components/SeasonPanel";
import type { GameView } from "../../src/client/view";

// Keys pass through with their params appended, so assertions can check both
// which string is shown and what it was filled with.
vi.mock("../../src/client/Utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/Utils")>()),
  translateText: (key: string, params?: Record<string, string | number>) =>
    params ? `${key}|${Object.values(params).join(",")}` : key,
}));

interface Toast {
  message: string;
  color: string;
}

function createPanel(state: { ticks: number; enabled?: boolean }) {
  const game = {
    config: () => ({ seasonsEnabled: () => state.enabled ?? true }),
    inSpawnPhase: () => false,
    ticksSinceStart: () => state.ticks,
  } as unknown as GameView;
  const panel = new SeasonPanel();
  panel.game = game;
  document.body.appendChild(panel);
  return panel;
}

describe("SeasonPanel", () => {
  const toasts: Toast[] = [];
  const onToast = (e: Event) => toasts.push((e as CustomEvent<Toast>).detail);

  beforeEach(() => {
    toasts.length = 0;
    window.addEventListener("show-message", onToast);
  });
  afterEach(() => {
    window.removeEventListener("show-message", onToast);
    document.body.innerHTML = "";
  });

  it("counts down to the next winter", async () => {
    const panel = createPanel({ ticks: 0 });
    await panel.updateComplete;
    expect(panel.textContent).toContain("seasons.winter_in|7:00");
    expect(panel.querySelector("[data-season=fair]")).not.toBeNull();
  });

  it("warns 30 seconds ahead, then shows the winter and its rules", async () => {
    const state = { ticks: SEASON_CYCLE_TICKS - 250 };
    const panel = createPanel(state);
    await panel.updateComplete;
    expect(panel.textContent).toContain("seasons.winter_coming|25");

    state.ticks = SEASON_CYCLE_TICKS + 300;
    panel.refreshKey++;
    await panel.updateComplete;
    expect(panel.textContent).toContain("seasons.winter_left|1:00");
    expect(panel.textContent).toContain("seasons.winter_effects");
  });

  it("announces the warning, the winter and the spring once each", async () => {
    const state = { ticks: SEASON_CYCLE_TICKS - 301 };
    const panel = createPanel(state);
    await panel.updateComplete;
    const step = async (ticks: number) => {
      state.ticks = ticks;
      panel.refreshKey++;
      await panel.updateComplete;
    };
    await step(SEASON_CYCLE_TICKS - 300);
    await step(SEASON_CYCLE_TICKS - 290);
    await step(SEASON_CYCLE_TICKS);
    await step(SEASON_CYCLE_TICKS + 899);
    await step(SEASON_CYCLE_TICKS + 900);
    expect(toasts.map((t) => t.message)).toEqual([
      "seasons.winter_coming|30",
      "seasons.winter_arrived",
      "seasons.spring",
    ]);
    expect(toasts.map((t) => t.color)).toEqual(["red", "red", "green"]);
  });

  it("is hidden when the game has seasons off", async () => {
    const panel = createPanel({
      ticks: SEASON_CYCLE_TICKS + 10,
      enabled: false,
    });
    await panel.updateComplete;
    expect(panel.style.display).toBe("none");
    expect(panel.textContent?.trim()).toBe("");
  });
});
