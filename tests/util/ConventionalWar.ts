import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { GameConfig } from "@openfront/engine-api/Schemas";
import { AirbaseExecution } from "@openfront/engine/execution/AirbaseExecution";
import { ConstructionExecution } from "@openfront/engine/execution/ConstructionExecution";
import { FlakGunExecution } from "@openfront/engine/execution/FlakGunExecution";
import { MissileSiloExecution } from "@openfront/engine/execution/MissileSiloExecution";
import { SAMLauncherExecution } from "@openfront/engine/execution/SAMLauncherExecution";
import { Game, Player, Unit } from "@openfront/engine/game/Game";
import { setup } from "./Setup";
import { executeTicks } from "./utils";

/** Conventional war test helpers: a game, structures and launches. */

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

/**
 * A conventional war game on `map` with human players `names` (no gold
 * unless the config says so). Spawn phase is over and nobody is immune.
 */
export async function conventionalGame(
  map: string,
  names: string[],
  config: Partial<GameConfig> = {},
): Promise<{ game: Game; players: Player[] }> {
  const game = await setup(
    map,
    { conventionalWar: true, instantBuild: true, ...config },
    names.map((n) => new PlayerInfo(n, PlayerType.Human, `c_${n}`, n)),
  );
  return { game, players: names.map((n) => game.player(n)) };
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
    case UnitType.Airbase:
      game.addExecution(new AirbaseExecution(unit));
      break;
    case UnitType.FlakGun:
      game.addExecution(new FlakGunExecution(unit));
      break;
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

/** Orders `type` at `tile` the way a build intent does. */
export function order(
  game: Game,
  player: Player,
  type: UnitType,
  tile: TileRef,
  extra: { troops?: number; count?: number } = {},
): void {
  game.addExecution(
    new ConstructionExecution(
      player,
      type,
      tile,
      undefined,
      undefined,
      undefined,
      extra.troops,
      extra.count,
    ),
  );
}

/** Runs ticks until `done` or `max` ticks pass; returns the ticks run. */
export function runUntil(game: Game, done: () => boolean, max = 600): number {
  for (let i = 0; i < max; i++) {
    if (done()) return i;
    executeTicks(game, 1);
  }
  return max;
}
