import { PlayerType } from "@openfront/engine-api/game/GameTypes";
import {
  HORDE_DEFENDERS_TEAM,
  HORDE_TEAM,
  hordeNightOutcome,
  isHordeDefender,
} from "@openfront/engine-lib/game/HordeNight";
import {
  INFECTED_PLAYER_ID,
  INFECTED_TEAM,
  plagueConsumedWorld,
} from "@openfront/engine-lib/game/Plague";
import { Game } from "../game/Game";
import { hordeNightOf } from "./HordeNightExecution";

/**
 * The win rules of the survival lobby modes, run by WinCheckExecution. Each
 * returns true once it has set the winner.
 */

/**
 * Horde Night: the horde wins once every defending human is dead or overrun
 * (under 25% of the land they held when the first wave landed). At the
 * survival timer the defenders win: outright if a human holds half of that
 * land, narrowly otherwise (the view names it from HordeNightExecution's
 * outcome).
 */
export function checkHordeNightWinner(mg: Game): boolean {
  const horde = hordeNightOf(mg);
  const humans = mg
    .allPlayers()
    .filter(
      (p) =>
        p.type() === PlayerType.Human && isHordeDefender(p) && p.hasSpawned(),
    )
    .map((p) => ({
      alive: p.isAlive(),
      tiles: p.numTilesOwned(),
      startTiles: horde?.startTiles(p) ?? null,
    }));
  const outcome = hordeNightOutcome({
    humans,
    ticksSinceStart: Math.round(mg.elapsedGameSeconds() * 10),
    survivalMinutes: mg.config().hordeNightConfig().survivalMinutes,
  });
  if (outcome === null) return false;
  horde?.setOutcome(outcome);
  mg.setWinner(
    outcome === "horde" ? HORDE_TEAM : HORDE_DEFENDERS_TEAM,
    mg.stats().stats(),
  );
  console.log(`horde night ended: ${outcome}`);
  return true;
}

/**
 * The plague: if The Infected holds PLAGUE_WORLD_LOSS_PERCENT of the land,
 * everyone loses: the winner is INFECTED_TEAM, which no player is on.
 * Wiping it out ends nothing; the usual rules decide the game.
 */
export function checkPlagueWinner(mg: Game): boolean {
  if (!mg.hasPlayer(INFECTED_PLAYER_ID)) return false;
  const infected = mg.player(INFECTED_PLAYER_ID);
  if (!infected.isAlive()) return false;
  if (!plagueConsumedWorld(infected.numTilesOwned(), mg.numLandTiles())) {
    return false;
  }
  mg.setWinner(INFECTED_TEAM, mg.stats().stats());
  console.log("the plague consumed the world");
  return true;
}
