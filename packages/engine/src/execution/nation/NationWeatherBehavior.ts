import { TileRef } from "@openfront/engine-api/game/GameMap";
import { Difficulty, TerraNullius } from "@openfront/engine-api/game/GameTypes";
import { WeatherKind } from "@openfront/engine-api/game/GameUpdates";
import { isSnowLand } from "@openfront/engine-lib/game/Seasons";
import {
  isCellActive,
  segmentCrossesCell,
} from "@openfront/engine-lib/game/Weather";
import { assertNever } from "@openfront/engine-lib/Util";
import { Game, Player } from "../../game/Game";

/**
 * How nations play the seasons and the weather. Stateless and draws nothing
 * from the PRNG, so it needs no snapshot:
 * - in winter, hold off big attacks into snow land: an attack sending more
 *   than winterAttackShare of the nation's troops waits for spring when most
 *   of the front it opens is snow. Harder nations hold off less.
 * - don't sail transport boats through an active sea storm: take a clear
 *   landing if there is one (AiAttackBehavior.planBoatRoute), else wait.
 */

/** Front tiles (enemy land across the border) that are enough to judge it. */
const FRONT_SAMPLE_TILES = 64;
/** Our border tiles scanned at most, so a huge border stays cheap. */
const FRONT_SCAN_BORDER_TILES = 4096;

/**
 * Share of its troops a nation still sends into snow land in winter: Easy
 * holds back nearly everything, Impossible only its biggest pushes.
 */
export function winterAttackShare(difficulty: Difficulty): number {
  switch (difficulty) {
    case Difficulty.Easy:
      return 0.1;
    case Difficulty.Medium:
      return 0.2;
    case Difficulty.Hard:
      return 0.3;
    case Difficulty.Impossible:
      return 0.45;
    default:
      assertNever(difficulty);
  }
}

/**
 * Whether more than half of `player`'s land front against `target` (the
 * first FRONT_SAMPLE_TILES tiles across the border, within
 * FRONT_SCAN_BORDER_TILES of our border tiles) is snow land. False with no
 * land front at all, so boat attacks are never held.
 */
export function frontIsMostlySnow(
  game: Game,
  player: Player,
  target: Player | TerraNullius,
): boolean {
  const map = game.map();
  const targetID = target.smallID();
  const nbuf: TileRef[] = [0, 0, 0, 0];
  let front = 0;
  let snow = 0;
  let scanned = 0;
  for (const border of player.borderTiles()) {
    if (++scanned > FRONT_SCAN_BORDER_TILES) break;
    const n = map.neighbors4(border, nbuf);
    for (let i = 0; i < n; i++) {
      const t = nbuf[i];
      if (
        map.ownerID(t) !== targetID ||
        !map.isLand(t) ||
        map.isImpassable(t)
      ) {
        continue;
      }
      front++;
      if (isSnowLand(map, t)) snow++;
    }
    if (front >= FRONT_SAMPLE_TILES) break;
  }
  return front > 0 && snow * 2 > front;
}

/** True when `player` should not send `troops` into `target` right now. */
export function holdsOffWinterAttack(
  game: Game,
  player: Player,
  target: Player | TerraNullius,
  troops: number,
): boolean {
  const config = game.config();
  if (!config.isWinter(game.ticksSinceStart())) return false;
  const share = winterAttackShare(config.gameConfig().difficulty);
  if (troops <= player.troops() * share) return false;
  return frontIsMostlySnow(game, player, target);
}

/**
 * Whether a boat sailing `route` (tiles in order; two tiles stand for the
 * straight line between them) passes through an active sea storm.
 */
export function routeCrossesStorm(
  game: Game,
  route: readonly TileRef[],
): boolean {
  const weather = game.weather();
  if (weather === null || route.length === 0) return false;
  const tick = game.ticks();
  const storms = weather
    .cells()
    .filter((c) => c.kind === WeatherKind.Storm && isCellActive(c, tick));
  if (storms.length === 0) return false;
  for (let i = 0; i < route.length; i++) {
    const a = route[i];
    const b = route[Math.min(i + 1, route.length - 1)];
    const ax = game.x(a);
    const ay = game.y(a);
    const bx = game.x(b);
    const by = game.y(b);
    for (const cell of storms) {
      if (segmentCrossesCell(cell, tick, ax, ay, bx, by)) return true;
    }
  }
  return false;
}
