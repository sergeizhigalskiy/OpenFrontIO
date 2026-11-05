import { TileRef } from "@openfront/engine-api/game/GameMap";
import { Gold, UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  canalPlanFor,
  CanalPathResult,
  findCanalPath,
} from "@openfront/engine-lib/game/Canal";
import { Game, Player } from "./Game";

/**
 * Engine side of the canal rules in engine-lib/game/Canal.ts: the price with
 * the player's cheats applied, and the build check PlayerImpl runs.
 */

/** What `player` pays for a canal of `length` steps. */
export function canalPrice(game: Game, player: Player, length: number): Gold {
  return game.unitInfo(UnitType.Canal).cost(game, player) * BigInt(length);
}

/** The canal `player` would dig through `tile`, or why they can't. */
export function canalPlan(
  game: Game,
  player: Player,
  tile: TileRef,
): CanalPathResult {
  return canalPlanFor(game.map(), player, tile);
}

/**
 * The build menu's price at `tile`: the path's price when there is a path
 * (whoever owns it), else the price of one step.
 */
export function canalMenuPrice(
  game: Game,
  player: Player,
  tile: TileRef,
): Gold {
  const found = findCanalPath(game.map(), tile);
  return canalPrice(game, player, found.ok ? found.path.length : 1);
}

/** `tile` when `player` can dig a canal through it right now, else false. */
export function canalSpawn(
  game: Game,
  player: Player,
  tile: TileRef,
): TileRef | false {
  if (!game.isValidRef(tile)) return false;
  const plan = canalPlan(game, player, tile);
  if (!plan.ok) return false;
  if (player.gold() < canalPrice(game, player, plan.path.length)) return false;
  return tile;
}
