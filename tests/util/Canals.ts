import { TileRef } from "@openfront/engine-api/game/GameMap";
import { Game, Player } from "@openfront/engine/game/Game";

/**
 * Helpers for canal tests on the all-land `plains` map (100x100): lakes are
 * dug with the same water conversion canals use, then flushed.
 */

/** Queues every land tile of the rectangle for water and flushes it. */
export function digLake(
  game: Game,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const t = game.ref(x, y);
      if (game.isLand(t) && !game.hasOwner(t)) {
        game.queueWaterConversion(t, true);
      }
    }
  }
  game.executeNextTick();
}

/** Gives `player` every land tile of the rectangle. */
export function claim(
  game: Game,
  player: Player,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const t = game.ref(x, y);
      if (game.isLand(t) && game.owner(t) !== player) player.conquer(t);
    }
  }
}

/** Ticks until the throttled water graph rebuild has run. */
export function tickUntilWaterRebuild(game: Game, maxTicks = 60): void {
  const version = game.waterGraphVersion();
  for (let i = 0; i < maxTicks; i++) {
    game.executeNextTick();
    if (game.waterGraphVersion() > version) return;
  }
  throw new Error(`water graph did not rebuild within ${maxTicks} ticks`);
}

/**
 * Two 20x20 lakes side by side on `plains`, x 20..39 and x 48..67 over
 * y 40..59, with an 8-tile neck of land between them (x 40..47).
 */
export const WEST_LAKE = { x0: 20, y0: 40, x1: 39, y1: 59 } as const;
export const EAST_LAKE = { x0: 48, y0: 40, x1: 67, y1: 59 } as const;

export function digTwoLakes(game: Game): void {
  digLake(game, WEST_LAKE.x0, WEST_LAKE.y0, WEST_LAKE.x1, WEST_LAKE.y1);
  digLake(game, EAST_LAKE.x0, EAST_LAKE.y0, EAST_LAKE.x1, EAST_LAKE.y1);
}

/** The tile at (x, y). */
export function at(game: Game, x: number, y: number): TileRef {
  return game.ref(x, y);
}
