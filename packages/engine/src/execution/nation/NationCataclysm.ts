import { TileRef } from "@openfront/engine-api/game/GameMap";
import { Game, Player } from "../../game/Game";
import { isNextToFlood } from "../RisingTideExecution";
import { inVolcanoWarning } from "../VolcanoExecution";

/**
 * How nations play around volcanoes and the rising tide. Both are lobby modes,
 * off by default, and everything here is a no-op while they are off.
 */

/** Border tiles sampled when looking for high ground to expand toward. */
const HIGH_GROUND_SAMPLE = 200;
/** How far past the border (tiles, along each axis) a nation looks. */
const HIGH_GROUND_REACH = 12;

const DIRECTIONS: readonly [number, number][] = [
  [0, -1],
  [0, 1],
  [-1, 0],
  [1, 0],
];

/**
 * Where a nation won't place a new structure: inside a rumbling volcano's
 * warning ring, or on a tile the coming tide wave floods.
 */
export function isCataclysmHazard(game: Game, tile: TileRef): boolean {
  return inVolcanoWarning(game, tile) || isNextToFlood(game, tile);
}

/**
 * Rising tide: the free land to push an expansion toward. From an even sample
 * of `player`'s border tiles, it looks up to HIGH_GROUND_REACH tiles out along
 * each axis, across free land only, and takes the highest tile seen (ties by
 * tile index). Null when the tide is off or all that land is equally high:
 * then there is no choice to make and the attack advances evenly.
 */
export function highGroundFocusTile(
  game: Game,
  player: Player,
): TileRef | null {
  if (!game.config().risingTide()) return null;
  const border = player.borderTiles();
  const stride = Math.max(1, Math.ceil(border.size / HIGH_GROUND_SAMPLE));
  const map = game.map();
  let best: TileRef | null = null;
  let bestMagnitude = -1;
  let lowestMagnitude = Infinity;
  let i = 0;
  for (const tile of border) {
    if (i++ % stride !== 0) continue;
    const x = map.x(tile);
    const y = map.y(tile);
    for (const [dx, dy] of DIRECTIONS) {
      for (let k = 1; k <= HIGH_GROUND_REACH; k++) {
        const nx = x + dx * k;
        const ny = y + dy * k;
        if (!map.isValidCoord(nx, ny)) break;
        const t = map.ref(nx, ny);
        if (!map.isLand(t) || map.isImpassable(t) || map.hasOwner(t)) break;
        const m = map.magnitude(t);
        if (m < lowestMagnitude) lowestMagnitude = m;
        if (m > bestMagnitude || (m === bestMagnitude && t < best!)) {
          best = t;
          bestMagnitude = m;
        }
      }
    }
  }
  return best !== null && bestMagnitude > lowestMagnitude ? best : null;
}
