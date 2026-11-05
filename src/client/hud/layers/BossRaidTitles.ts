import { Team } from "@openfront/engine-api/game/GameTypes";
import {
  BOSS_RAID_BOSS_TEAM,
  BOSS_RAID_RAIDER_TEAM,
} from "@openfront/engine-lib/game/BossRaid";
import { translateText } from "../../Utils";

/**
 * The end screen's title for a Boss Raid, from the viewer's side: the Boss
 * and the Raiders each get their own win and loss line, and a spectator is
 * told who won.
 */
export function bossRaidWinTitle(winner: Team, myTeam: Team | null): string {
  const raidersWon = winner === BOSS_RAID_RAIDER_TEAM;
  if (myTeam === BOSS_RAID_BOSS_TEAM) {
    return translateText(
      raidersWon ? "boss_raid.lose_as_boss" : "boss_raid.win_as_boss",
    );
  }
  if (myTeam === BOSS_RAID_RAIDER_TEAM) {
    return translateText(
      raidersWon ? "boss_raid.win_as_raider" : "boss_raid.lose_as_raider",
    );
  }
  return translateText(
    raidersWon ? "boss_raid.raiders_won" : "boss_raid.boss_won",
  );
}
