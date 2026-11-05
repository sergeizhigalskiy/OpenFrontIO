import { GameMode, PlayerType } from "@openfront/engine-api/game/GameTypes";
import {
  HORDE_DEFENDERS_TEAM,
  HORDE_TEAM,
  hordeNightOutcome,
  isHordeDefender,
} from "@openfront/engine-lib/game/HordeNight";
import {
  INFECTED_PLAYER_ID,
  INFECTED_TEAM,
  isInfected,
  plagueConsumedWorld,
} from "@openfront/engine-lib/game/Plague";
import { Game, Player } from "../game/Game";

/**
 * The win rules of the survival lobby modes, run by WinCheckExecution. Each
 * returns true once it has set the winner.
 */

/**
 * Horde Night: the defenders win when a defending human has survived the
 * survival timer, the horde when every defending human is gone.
 */
export function checkHordeNightWinner(mg: Game): boolean {
  const humans = mg
    .allPlayers()
    .filter(
      (p) =>
        p.type() === PlayerType.Human && isHordeDefender(p) && p.hasSpawned(),
    );
  const outcome = hordeNightOutcome({
    spawnedHumans: humans.length,
    aliveHumans: humans.filter((p) => p.isAlive()).length,
    ticksSinceStart: Math.round(mg.elapsedGameSeconds() * 10),
    survivalMinutes: mg.config().hordeNightConfig().survivalMinutes,
  });
  if (outcome === null) return false;
  mg.setWinner(
    outcome === "defenders" ? HORDE_DEFENDERS_TEAM : HORDE_TEAM,
    mg.stats().stats(),
  );
  console.log(`horde night won by the ${outcome}`);
  return true;
}

/**
 * The plague: once The Infected is wiped out, the living human or nation
 * with the most land wins (their team in team games). If The Infected holds
 * PLAGUE_WORLD_LOSS_PERCENT of the land, everyone loses: the winner is
 * INFECTED_TEAM, which no player is on.
 */
export function checkPlagueWinner(mg: Game): boolean {
  if (!mg.hasPlayer(INFECTED_PLAYER_ID)) return false;
  const infected = mg.player(INFECTED_PLAYER_ID);
  if (!infected.hasSpawned()) return false;
  if (infected.isAlive()) {
    if (!plagueConsumedWorld(infected.numTilesOwned(), mg.numLandTiles())) {
      return false;
    }
    mg.setWinner(INFECTED_TEAM, mg.stats().stats());
    console.log("the plague consumed the world");
    return true;
  }
  let survivor: Player | null = null;
  for (const p of mg.players()) {
    if (p.type() === PlayerType.Bot || isInfected(p)) continue;
    if (survivor === null || p.numTilesOwned() > survivor.numTilesOwned()) {
      survivor = p;
    }
  }
  if (survivor === null) return false;
  const team = survivor.team();
  mg.setWinner(
    mg.config().gameConfig().gameMode === GameMode.Team && team !== null
      ? team
      : survivor,
    mg.stats().stats(),
  );
  console.log(`the plague is gone, ${survivor.name()} has won`);
  return true;
}
