import { GameMode, PlayerType } from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { Config } from "@openfront/engine-lib/configuration/Config";
import {
  BOSS_RAID_BOSS_TEAM,
  BOSS_RAID_HUMAN_WEIGHT_HUNDREDTHS,
  BOSS_RAID_NATION_WEIGHT_HUNDREDTHS,
  BOSS_RAID_RAIDER_TEAM,
} from "@openfront/engine-lib/game/BossRaid";
import { describe, expect, it, vi } from "vitest";
import { bossRaidWinTitle } from "../../src/client/hud/layers/BossRaidTitles";
import { notableLobbySettings } from "../../src/client/utilities/LobbySettingsSummary";
import { makeEmptyGu, makeGameView, makePlayerUpdate } from "../util/viewStubs";
import { testGameConfig } from "../util/Wire";

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
  return { modal, starts };
}

describe("Boss Raid in the singleplayer modal", () => {
  it("starts a Team game against a nation Boss, timed at 25 minutes", async () => {
    const { modal, starts } = singlePlayer();
    modal.nations = 6;
    modal.handleBossRaidSelected();
    await modal.startGame();
    expect(starts).toHaveLength(1);
    const config = starts[0].gameStartInfo.config;
    expect(config.gameMode).toBe(GameMode.Team);
    expect(config.bossRaid).toEqual({ boss: "nation" });
    expect(config.maxTimerValue).toBe(25);
    expect(config.donateTroops).toBe(true);
  });

  it("refuses to start a nation Boss raid with nations off", async () => {
    const { modal, starts } = singlePlayer();
    modal.nations = 0;
    modal.handleBossRaidSelected();
    await modal.startGame();
    expect(starts).toHaveLength(0);
  });

  it("drops the raid when another mode is picked", async () => {
    const { modal, starts } = singlePlayer();
    modal.nations = 6;
    modal.handleBossRaidSelected();
    modal.handleConfigGameModeSelected(
      new CustomEvent("game-mode-selected", {
        detail: { mode: GameMode.Team },
      }),
    );
    await modal.startGame();
    expect(starts[0].gameStartInfo.config.bossRaid).toBeUndefined();
  });
});

describe("Boss Raid lobby summary and end screen", () => {
  it("names the mode and the Boss in the lobby summary", () => {
    const labels = (c: Parameters<typeof notableLobbySettings>[0]) =>
      notableLobbySettings(c, null).map((s) => `${s.label}=${s.value}`);
    expect(
      labels(
        testGameConfig({
          gameMode: GameMode.Team,
          bossRaid: { boss: "nation" },
        }),
      ),
    ).toContain("game_mode.boss_raid=boss_raid.nation_boss");
    expect(
      labels(
        testGameConfig({
          gameMode: GameMode.Team,
          bossRaid: { boss: "aB3dEf7h" },
        }),
      ),
    ).toContain("game_mode.boss_raid=boss_raid.player_boss");
    expect(labels(testGameConfig({ gameMode: GameMode.Team }))).not.toContain(
      "game_mode.boss_raid=boss_raid.nation_boss",
    );
  });

  it.each([
    [BOSS_RAID_RAIDER_TEAM, BOSS_RAID_RAIDER_TEAM, "boss_raid.win_as_raider"],
    [BOSS_RAID_BOSS_TEAM, BOSS_RAID_RAIDER_TEAM, "boss_raid.lose_as_raider"],
    [BOSS_RAID_BOSS_TEAM, BOSS_RAID_BOSS_TEAM, "boss_raid.win_as_boss"],
    [BOSS_RAID_RAIDER_TEAM, BOSS_RAID_BOSS_TEAM, "boss_raid.lose_as_boss"],
    [BOSS_RAID_RAIDER_TEAM, null, "boss_raid.raiders_won"],
    [BOSS_RAID_BOSS_TEAM, null, "boss_raid.boss_won"],
  ])("%s won, viewer on %s: %s", (winner, mine, title) => {
    expect(bossRaidWinTitle(winner, mine)).toBe(title);
  });
});

describe("Boss Raid in the client's view", () => {
  it("weighs the raiders once the teams arrive, so the Boss's cap matches the engine's", () => {
    const config = new Config(
      testGameConfig({ gameMode: GameMode.Team, bossRaid: { boss: "nation" } }),
      false,
    );
    const view = makeGameView({ config });
    const gu = makeEmptyGu(1);
    gu.updates[GameUpdateType.Player] = [
      makePlayerUpdate({ id: "boss", smallID: 1, team: BOSS_RAID_BOSS_TEAM }),
      makePlayerUpdate({ id: "me", smallID: 2, team: BOSS_RAID_RAIDER_TEAM }),
      makePlayerUpdate({
        id: "n1",
        smallID: 3,
        clientID: null,
        playerType: PlayerType.Nation,
        team: BOSS_RAID_RAIDER_TEAM,
      }),
      makePlayerUpdate({
        id: "tribe",
        smallID: 4,
        clientID: null,
        playerType: PlayerType.Bot,
        team: "Bot",
      }),
    ];
    view.update(gu);
    // W: the human and the nation, by their weights; not the tribe.
    expect(config.bossRaidRaiderWeight()).toBe(
      BOSS_RAID_HUMAN_WEIGHT_HUNDREDTHS +
        BOSS_RAID_NATION_WEIGHT_HUNDREDTHS[config.gameConfig().difficulty],
    );
    // The lobby left the timer unset: the Boss Raid default shows in the HUD.
    expect(config.gameConfig().maxTimerValue).toBe(25);
  });
});
