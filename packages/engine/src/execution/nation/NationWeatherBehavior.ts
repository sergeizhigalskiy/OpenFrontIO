import { TileRef } from "@openfront/engine-api/game/GameMap";
import { Difficulty, TerraNullius } from "@openfront/engine-api/game/GameTypes";
import {
  WeatherCell,
  WeatherKind,
} from "@openfront/engine-api/game/GameUpdates";
import {
  isSnowLand,
  SeasonPhase,
  seasonAt,
} from "@openfront/engine-lib/game/Seasons";
import {
  cellCovers,
  isCellActive,
  segmentCrossesCell,
} from "@openfront/engine-lib/game/Weather";
import { assertNever } from "@openfront/engine-lib/Util";
import { Game, Player } from "../../game/Game";

/**
 * How nations play the seasons and the weather, by difficulty (the spec's
 * difficulty ladder). Every hold here is for offensive attacks only:
 * NationAttackBehavior never asks about an attack that hits back, retakes
 * land or joins an ally's war. Stateless and draws nothing from the PRNG,
 * so it needs no snapshot.
 *
 * Winter:
 *  - Easy holds pushes of more than 25% of its troops into a snow front,
 *    Medium more than 40% (winterHoldShare).
 *  - Hard and Impossible never hold. They rank an enemy behind a snow front
 *    as NATION_SNOW_FRONT_WEIGHT times its troops, so they prefer fronts
 *    without snow, and Impossible launches early in the winter warning
 *    where its front has no snow (launchesEarlyBeforeWinter).
 * Storms:
 *  - Easy and Medium wait out any active storm on the route.
 *  - Hard sails through a short one (NATION_SHORT_STORM_TILES).
 *  - Impossible picks the landing with the least storm on the way, then
 *    sails through it if that is short (NationAttackBehavior.boatRoute).
 * Mud:
 *  - Easy and Medium wait while a mud front covers most of the front.
 *  - Hard and Impossible rank a muddy front as NATION_MUD_FRONT_WEIGHT
 *    times the enemy's troops, and Impossible holds an attack into it if the
 *    mud clears within NATION_MUD_CLEARS_TICKS.
 *
 * A front is "snow" or "mud" when more than half of it is: its tiles are the
 * target's land across our border, the first FRONT_SAMPLE_TILES of them.
 */

/** Front tiles (enemy land across the border) that are enough to judge it. */
const FRONT_SAMPLE_TILES = 64;
/** Our border tiles scanned at most, so a huge border stays cheap. */
const FRONT_SCAN_BORDER_TILES = 4096;

/** Hard and Impossible rank an enemy behind a snow front, in winter, as this many times its troops. */
export const NATION_SNOW_FRONT_WEIGHT = 1.25;
/** Hard and Impossible rank an enemy behind a mud front as this many times its troops. */
export const NATION_MUD_FRONT_WEIGHT = 1.25;
/** Hard and Impossible sail through a storm covering at most this many tiles of the route. */
export const NATION_SHORT_STORM_TILES = 15;
/** Impossible holds an attack into a mud front that clears within this many ticks (20 s). */
export const NATION_MUD_CLEARS_TICKS = 20 * 10;

/**
 * Share of its troops above which a nation holds an offensive push into a
 * snow front in winter: Easy 25%, Medium 40%. Null: it never holds.
 */
export function winterHoldShare(difficulty: Difficulty): number | null {
  switch (difficulty) {
    case Difficulty.Easy:
      return 0.25;
    case Difficulty.Medium:
      return 0.4;
    case Difficulty.Hard:
    case Difficulty.Impossible:
      return null;
    default:
      assertNever(difficulty);
  }
}

/** The weather on one front, from its sampled tiles. */
export interface FrontWeather {
  /** Front tiles sampled. */
  front: number;
  /** Of those, snow land (Seasons.isSnowLand), winter or not. */
  snow: number;
  /** Of those, enemy land under an active mud front. */
  mud: number;
  /** The last tick a mud front over those tiles stays active; 0 without one. */
  mudUntil: number;
}

/** More than half of the front is snow land. */
export function isSnowFront(w: FrontWeather | undefined): boolean {
  return w !== undefined && w.front > 0 && w.snow * 2 > w.front;
}

/** More than half of the front is under an active mud front. */
export function isMudFront(w: FrontWeather | undefined): boolean {
  return w !== undefined && w.front > 0 && w.mud * 2 > w.front;
}

/** The weather cells of `kind` in effect now. */
function activeCells(game: Game, kind: WeatherKind): WeatherCell[] {
  const weather = game.weather();
  if (weather === null) return [];
  const tick = game.ticks();
  return weather
    .cells()
    .filter((c) => c.kind === kind && isCellActive(c, tick));
}

/** Whether a mud front is in effect anywhere on the map. */
export function hasActiveMud(game: Game): boolean {
  return activeCells(game, WeatherKind.Mud).length > 0;
}

/**
 * The weather on `player`'s land fronts, by the owner's small ID across the
 * border (0 for free land), or on the one front against `only`.
 */
function scanFronts(
  game: Game,
  player: Player,
  only: number | null,
): Map<number, FrontWeather> {
  const map = game.map();
  const own = player.smallID();
  const tick = game.ticks();
  const mud = activeCells(game, WeatherKind.Mud);
  const out = new Map<number, FrontWeather>();
  const nbuf: TileRef[] = [0, 0, 0, 0];
  let scanned = 0;
  for (const border of player.borderTiles()) {
    if (++scanned > FRONT_SCAN_BORDER_TILES) break;
    const n = map.neighbors4(border, nbuf);
    for (let i = 0; i < n; i++) {
      const t = nbuf[i];
      const owner = map.ownerID(t);
      if (owner === own || (only !== null && owner !== only)) continue;
      if (!map.isLand(t) || map.isImpassable(t)) continue;
      let w = out.get(owner);
      if (w === undefined) {
        w = { front: 0, snow: 0, mud: 0, mudUntil: 0 };
        out.set(owner, w);
      }
      if (w.front >= FRONT_SAMPLE_TILES) continue;
      w.front++;
      if (isSnowLand(map, t)) w.snow++;
      // Mud only slows taking a player's land.
      if (owner === 0 || mud.length === 0) continue;
      const x = map.x(t);
      const y = map.y(t);
      let until = 0;
      for (const cell of mud) {
        if (cellCovers(cell, tick, x, y)) until = Math.max(until, cell.endTick);
      }
      if (until > 0) {
        w.mud++;
        w.mudUntil = Math.max(w.mudUntil, until);
      }
    }
    if (only !== null && (out.get(only)?.front ?? 0) >= FRONT_SAMPLE_TILES) {
      break;
    }
  }
  return out;
}

/** The weather on `player`'s land front against `target`. */
export function frontWeather(
  game: Game,
  player: Player,
  target: Player | TerraNullius,
): FrontWeather {
  const id = target.smallID();
  return (
    scanFronts(game, player, id).get(id) ?? {
      front: 0,
      snow: 0,
      mud: 0,
      mudUntil: 0,
    }
  );
}

/** The weather on every land front of `player`, by the owner's small ID. */
export function frontWeatherByOwner(
  game: Game,
  player: Player,
): Map<number, FrontWeather> {
  return scanFronts(game, player, null);
}

/**
 * Whether more than half of `player`'s land front against `target` is snow
 * land. False with no land front at all, so boat attacks are never held.
 */
export function frontIsMostlySnow(
  game: Game,
  player: Player,
  target: Player | TerraNullius,
): boolean {
  return isSnowFront(frontWeather(game, player, target));
}

/**
 * What Hard and Impossible multiply an enemy's troops by when ranking it,
 * for the weather on its front: NATION_SNOW_FRONT_WEIGHT for a snow front in
 * winter, NATION_MUD_FRONT_WEIGHT for a mud front. 1 on other difficulties.
 */
export function frontHardness(
  game: Game,
  player: Player,
  w: FrontWeather | undefined,
): number {
  const difficulty = game.config().difficultyFor(player);
  if (difficulty !== Difficulty.Hard && difficulty !== Difficulty.Impossible) {
    return 1;
  }
  let hardness = 1;
  if (game.config().isWinter(game.ticksSinceStart()) && isSnowFront(w)) {
    hardness *= NATION_SNOW_FRONT_WEIGHT;
  }
  if (isMudFront(w)) hardness *= NATION_MUD_FRONT_WEIGHT;
  return hardness;
}

/** Whether Hard and Impossible need frontHardness now: in winter or with mud about. */
export function ranksFrontsByWeather(game: Game, player: Player): boolean {
  const difficulty = game.config().difficultyFor(player);
  if (difficulty !== Difficulty.Hard && difficulty !== Difficulty.Impossible) {
    return false;
  }
  return game.config().isWinter(game.ticksSinceStart()) || hasActiveMud(game);
}

/**
 * True when `player` holds an offensive attack sending `troops` at `target`
 * for the weather right now (never asked for an attack that answers one):
 *  - winter: Easy and Medium hold a push above winterHoldShare of their
 *    troops into a snow front;
 *  - mud: Easy and Medium wait while mud covers most of the front, and
 *    Impossible while that mud clears within NATION_MUD_CLEARS_TICKS.
 */
export function holdsForWeather(
  game: Game,
  player: Player,
  target: Player | TerraNullius,
  troops: number,
): boolean {
  const config = game.config();
  const difficulty = config.difficultyFor(player);
  const share = winterHoldShare(difficulty);
  const winterHold =
    share !== null &&
    config.isWinter(game.ticksSinceStart()) &&
    troops > player.troops() * share;
  const mudHold =
    target.isPlayer() && difficulty !== Difficulty.Hard && hasActiveMud(game);
  if (!winterHold && !mudHold) return false;
  const w = frontWeather(game, player, target);
  if (winterHold && isSnowFront(w)) return true;
  if (!mudHold || !isMudFront(w)) return false;
  if (difficulty === Difficulty.Impossible) {
    return w.mudUntil - game.ticks() <= NATION_MUD_CLEARS_TICKS;
  }
  return true;
}

/**
 * Impossible launches early in the winter warning: in the 30 s before a
 * winter it skips its trigger-ratio wait, for an attack whose front has no
 * snow (the caller checks the front).
 */
export function launchesEarlyBeforeWinter(game: Game, player: Player): boolean {
  const config = game.config();
  return (
    config.difficultyFor(player) === Difficulty.Impossible &&
    config.seasonsEnabled() &&
    seasonAt(game.ticksSinceStart()).phase === SeasonPhase.Warning
  );
}

/**
 * Whether a boat sailing `route` (tiles in order; two tiles stand for the
 * straight line between them) passes through an active sea storm.
 */
export function routeCrossesStorm(
  game: Game,
  route: readonly TileRef[],
): boolean {
  if (route.length === 0) return false;
  const storms = activeCells(game, WeatherKind.Storm);
  if (storms.length === 0) return false;
  const tick = game.ticks();
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

/**
 * How many tiles of `route` (read as routeCrossesStorm reads it) lie inside
 * an active sea storm: what the boat would sail through.
 */
export function routeStormTiles(game: Game, route: readonly TileRef[]): number {
  if (route.length === 0) return 0;
  const storms = activeCells(game, WeatherKind.Storm);
  if (storms.length === 0) return 0;
  const tick = game.ticks();
  const inStorm = (x: number, y: number) =>
    storms.some((cell) => cellCovers(cell, tick, x, y));
  let count = 0;
  // Each segment's tiles up to its end; the last tile once, at the end.
  for (let i = 0; i + 1 < route.length; i++) {
    const ax = game.x(route[i]);
    const ay = game.y(route[i]);
    const dx = game.x(route[i + 1]) - ax;
    const dy = game.y(route[i + 1]) - ay;
    const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);
    for (let s = 0; s < steps; s++) {
      if (inStorm(ax + (dx * s) / steps, ay + (dy * s) / steps)) count++;
    }
  }
  const last = route[route.length - 1];
  if (inStorm(game.x(last), game.y(last))) count++;
  return count;
}

/**
 * Whether `player` treats a route with `stormTiles` tiles of storm as
 * stormy, so it waits or looks for another landing: any storm for Easy,
 * Medium and Impossible (which then picks the safest landing), more than
 * NATION_SHORT_STORM_TILES for Hard.
 */
export function avoidsStorm(
  game: Game,
  player: Player,
  stormTiles: number,
): boolean {
  if (stormTiles === 0) return false;
  return (
    game.config().difficultyFor(player) !== Difficulty.Hard ||
    stormTiles > NATION_SHORT_STORM_TILES
  );
}
