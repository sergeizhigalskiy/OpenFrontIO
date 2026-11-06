import { GameMode } from "@openfront/engine-api/game/GameTypes";
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/Cosmetics", () => ({
  getPlayerCosmetics: vi.fn(async () => ({})),
}));

vi.mock("../../src/client/CrazyGamesSDK", () => ({
  crazyGamesSDK: {
    isOnCrazyGames: vi.fn(() => false),
    requestMidgameAd: vi.fn(async () => {}),
  },
}));

vi.mock("../../src/client/TerrainMapFileLoader", () => ({
  terrainMapFileLoader: { getMapData: vi.fn() },
}));

// Side-effect imports so the custom elements register.
import "../../src/client/components/GameConfigSettings";
import "../../src/client/SinglePlayerModal";

function singlePlayer(): any {
  const modal = document.createElement("single-player-modal") as any;
  const starts: any[] = [];
  modal.addEventListener("join-lobby", (e: Event) =>
    starts.push((e as CustomEvent).detail),
  );
  modal.nations = 6;
  return { modal, starts };
}

function togglePlague(modal: any, checked: boolean): void {
  modal.handleConfigOptionToggleChanged(
    new CustomEvent("option-toggle-changed", {
      detail: { labelKey: "game_settings.plague", checked },
    }),
  );
}

describe("Boss Raid, Horde Night and the plague in the singleplayer modal", () => {
  it("turns the others off when one is switched on", async () => {
    const { modal, starts } = singlePlayer();
    modal.handleBossRaidSelected();
    togglePlague(modal, true);
    expect(modal.bossRaidOn()).toBe(false);
    expect(modal.plague).toBe(true);

    modal.handleConfigOptionToggleChanged(
      new CustomEvent("option-toggle-changed", {
        detail: { labelKey: "game_settings.horde_night", checked: true },
      }),
    );
    expect(modal.hordeNight).toBe(true);
    expect(modal.plague).toBe(false);

    modal.handleBossRaidSelected();
    expect(modal.bossRaidOn()).toBe(true);
    expect(modal.hordeNight).toBe(false);

    await modal.startGame();
    expect(starts).toHaveLength(1);
    const config = starts[0].gameStartInfo.config;
    expect(config.gameMode).toBe(GameMode.Team);
    expect(config.bossRaid).toEqual({ boss: "nation" });
    expect(config.hordeNight).toBeUndefined();
    expect(config.plague).toBeUndefined();
  });

  it("Horde Night: 25 minutes unless picked, donations on", async () => {
    const { modal, starts } = singlePlayer();
    modal.handleConfigOptionToggleChanged(
      new CustomEvent("option-toggle-changed", {
        detail: { labelKey: "game_settings.horde_night", checked: true },
      }),
    );
    await modal.startGame();
    let config = starts[0].gameStartInfo.config;
    expect(config.hordeNight).toEqual({ enabled: true, survivalMinutes: 25 });
    expect(config.donateTroops).toBe(true);
    expect(config.donateGold).toBe(true);

    const other = singlePlayer();
    other.modal.handleConfigOptionToggleChanged(
      new CustomEvent("option-toggle-changed", {
        detail: { labelKey: "game_settings.horde_night", checked: true },
      }),
    );
    other.modal.handleConfigOptionMinutesSelected(
      new CustomEvent("option-minutes-selected", {
        detail: { labelKey: "game_settings.horde_night", minutes: 45 },
      }),
    );
    await other.modal.startGame();
    config = other.starts[0].gameStartInfo.config;
    expect(config.hordeNight).toEqual({ enabled: true, survivalMinutes: 45 });
  });

  it("refuses to start with two of them on (a preset, say)", async () => {
    const { modal, starts } = singlePlayer();
    modal.hordeNight = true;
    modal.plague = true;
    await modal.startGame();
    expect(starts).toHaveLength(0);
  });
});

describe("a mode toggle in the lobby settings", () => {
  it("shows the length choices and the win rule while on", () => {
    const el = document.createElement("game-config-settings") as any;
    const toggle = (checked: boolean) => ({
      labelKey: "game_settings.horde_night",
      checked,
      minuteChoices: { options: [15, 20, 25, 30, 45], selected: 25 },
      ruleKey: "horde_night.rules",
    });
    const host = document.createElement("div");
    render(el.renderOptionToggle(toggle(false)), host);
    expect(host.querySelector("[data-mode-rule]")).toBeNull();
    expect(host.querySelector("select")).toBeNull();

    render(el.renderOptionToggle(toggle(true)), host);
    expect(host.querySelector("[data-mode-rule]")).not.toBeNull();
    const select = host.querySelector("select") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      "15",
      "20",
      "25",
      "30",
      "45",
    ]);
    expect(select.value).toBe("25");
    const picked: unknown[] = [];
    el.addEventListener("option-minutes-selected", (e: Event) =>
      picked.push((e as CustomEvent).detail),
    );
    select.value = "45";
    select.dispatchEvent(new Event("change"));
    expect(picked).toEqual([
      { labelKey: "game_settings.horde_night", minutes: 45 },
    ]);
  });
});
