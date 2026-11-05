import { GameMode } from "@openfront/engine-api/game/GameTypes";
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

// Side-effect import so the custom element registers.
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

    modal.handleHordeNightToggle(true, 30);
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

  it("refuses to start with two of them on (a preset, say)", async () => {
    const { modal, starts } = singlePlayer();
    modal.hordeNight = true;
    modal.plague = true;
    await modal.startGame();
    expect(starts).toHaveLength(0);
  });
});
