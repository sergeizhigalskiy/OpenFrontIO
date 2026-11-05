import { Difficulty } from "@openfront/engine-api/game/GameTypes";
import {
  BOSS_RAID_BOSS_TEAM,
  BOSS_RAID_RAIDER_TEAM,
  isBossRaid,
} from "@openfront/engine-lib/game/BossRaid";
import { Game, Player } from "../../game/Game";

// Boss Raid targeting for nation Raiders. Their teammates are already off
// limits (same team), so what is left to choose between is the Boss and the
// tribes. The Boss strategy goes into the nation's attack order at a
// difficulty-scaled slot, the same way every other strategy is ranked
// (NationAttackBehavior.getAttackStrategies): Impossible goes for the Boss
// before anything else, Easy only after its usual opening moves.

/** Where the Boss strategy sits in each difficulty's attack order. */
export const BOSS_STRATEGY_SLOT: Record<Difficulty, number> = {
  [Difficulty.Easy]: 3,
  [Difficulty.Medium]: 2,
  [Difficulty.Hard]: 1,
  [Difficulty.Impossible]: 0,
};

/** The living Boss, when `player` is a Raider in a Boss Raid. */
export function bossFor(game: Game, player: Player): Player | null {
  if (!isBossRaid(game.config().gameConfig())) return null;
  if (player.team() !== BOSS_RAID_RAIDER_TEAM) return null;
  for (const p of game.players()) {
    if (p.team() === BOSS_RAID_BOSS_TEAM) return p;
  }
  return null;
}

/**
 * `strategies` with `boss` slotted in for a Raider, unchanged otherwise.
 */
export function withBossStrategy<T>(
  strategies: T[],
  boss: T,
  isRaider: boolean,
  difficulty: Difficulty,
): T[] {
  if (!isRaider) return strategies;
  const slot = Math.min(BOSS_STRATEGY_SLOT[difficulty], strategies.length);
  return [...strategies.slice(0, slot), boss, ...strategies.slice(slot)];
}
