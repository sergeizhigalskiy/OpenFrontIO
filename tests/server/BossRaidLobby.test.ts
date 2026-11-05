import {
  GameMapType,
  GameMode,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { GameConfig } from "@openfront/engine-api/Schemas";
import {
  BOSS_RAID_BOSS_TEAM,
  BOSS_RAID_RAIDER_TEAM,
} from "@openfront/engine-lib/game/BossRaid";
import { createPartialGameRecord } from "@openfront/shared/SharedUtil";
import { PlayerRecord } from "@openfront/shared/WireSchemas";
import { describe, expect, it } from "vitest";
import { applyGameConfigPatch } from "../../src/server/ConfigPatch";
import { setup } from "../util/Setup";
import { testGameConfig } from "../util/Wire";

const ids = ["Pl000000", "Pl000001", "Pl000002"];

function bossRaidConfig(boss: string): GameConfig {
  return testGameConfig({
    gameMap: GameMapType.World,
    gameMode: GameMode.Team,
    playerTeams: 2,
    nations: "disabled",
    bossRaid: { boss },
  });
}

describe("Boss Raid lobby config", () => {
  it("takes the host's Boss pick and nothing the engine fills in", () => {
    const config = testGameConfig({ gameMode: GameMode.Team });
    applyGameConfigPatch(config, {
      bossRaid: { boss: "aB3dEf7h", raiders: 99 },
    });
    expect(config.bossRaid).toEqual({ boss: "aB3dEf7h" });
    applyGameConfigPatch(config, { bots: 3 });
    expect(config.bossRaid).toEqual({ boss: "aB3dEf7h" });
    applyGameConfigPatch(config, { bossRaid: null });
    expect(config.bossRaid).toBeUndefined();
  });

  it("records each player's Boss Raid team, as the game assigns it", async () => {
    const config = bossRaidConfig(ids[1]);
    const players: PlayerRecord[] = ids.map((clientID, i) => ({
      clientID,
      username: `player${i}`,
      clanTag: null,
      persistentID: null,
      stats: undefined,
    }));
    const record = createPartialGameRecord(
      "bOss1234",
      config,
      players,
      [],
      0,
      1000,
      undefined,
    );
    const recorded = record.info.players.map((p) => p.team);
    expect(recorded).toEqual([
      BOSS_RAID_RAIDER_TEAM,
      BOSS_RAID_BOSS_TEAM,
      BOSS_RAID_RAIDER_TEAM,
    ]);

    const game = await setup(
      "plains",
      config,
      ids.map(
        (id, i) => new PlayerInfo(`player${i}`, PlayerType.Human, id, id),
      ),
    );
    expect(ids.map((id) => game.playerByClientID(id)?.team())).toEqual(
      recorded,
    );
  });
});
