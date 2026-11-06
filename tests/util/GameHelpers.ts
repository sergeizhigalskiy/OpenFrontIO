import { TileRef } from "@openfront/engine-api/game/GameMap";
import { UnitType } from "@openfront/engine-api/game/GameTypes";
import { MissileSiloExecution } from "@openfront/engine/execution/MissileSiloExecution";
import { SAMLauncherExecution } from "@openfront/engine/execution/SAMLauncherExecution";
import { Game, Player, Unit } from "@openfront/engine/game/Game";
import { executeTicks } from "./utils";

/** Game test helpers: land, structures, gold and waiting. */

export function conquerRect(
  game: Game,
  p: Player,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  for (let x = x0; x < x1; x++) {
    for (let y = y0; y < y1; y++) {
      const t = game.ref(x, y);
      if (game.isLand(t) && !game.isImpassable(t)) p.conquer(t);
    }
  }
}

/** Builds a finished structure of `type` with its execution. */
export function structure(
  game: Game,
  owner: Player,
  type: UnitType,
  tile: TileRef,
  level = 1,
): Unit {
  const unit = owner.buildUnit(type, tile, {});
  for (let l = 1; l < level; l++) unit.increaseLevel();
  // Upgrades queue their new missiles for reload; start loaded.
  while (unit.missileTimerQueue().length > 0) unit.reloadMissile();
  switch (type) {
    case UnitType.MissileSilo:
      game.addExecution(new MissileSiloExecution(unit));
      break;
    case UnitType.SAMLauncher:
      game.addExecution(new SAMLauncherExecution(owner, null, unit));
      break;
  }
  return unit;
}

/** Sets `player`'s gold to exactly `gold` (structures built in tests cost gold). */
export function setGold(player: Player, gold: bigint): void {
  player.removeGold(player.gold());
  player.addGold(gold);
}

/** Runs ticks until `done` or `max` ticks pass; returns the ticks run. */
export function runUntil(game: Game, done: () => boolean, max = 600): number {
  for (let i = 0; i < max; i++) {
    if (done()) return i;
    executeTicks(game, 1);
  }
  return max;
}
