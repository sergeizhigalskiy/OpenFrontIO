import { TileRef } from "@openfront/engine-api/game/GameMap";
import { PlayerType } from "@openfront/engine-api/game/GameTypes";
import { VOLCANO_WARNING_RADIUS } from "@openfront/engine-lib/game/Volcanoes";
import { CITY_STATE_RADIUS } from "@openfront/engine-lib/game/WorldFeatures";
import { CityStateExecution } from "../execution/CityStateExecution";
import { Game } from "./Game";

/**
 * The features placed at game start share the map in a fixed order:
 * city-states, then volcanoes, then ruins. Each one keeps clear of the zones
 * of those placed before it, so a volcano's warning ring never reaches a
 * city-state's disc, and a ruin never lands in either.
 *
 * Each placer already runs in that order (city-states in GameRunner.init,
 * volcanoes when their execution starts at tick 0, then ruins on the first
 * tick the spawns are settled), and every zone is read off the game: the
 * pending or founded city-states and the volcano execution's sites. So a
 * restored game places exactly what the original did, and none of this
 * needs a snapshot of its own. (The volcano sites come from
 * VolcanoExecution's volcanoSitesOf; the placers pass them in, which keeps
 * this module free of import cycles.)
 */

/**
 * Ticks after the spawn phase ends before the spawns are final: a spawn
 * picked on the phase's last tick lands on the tick it ends.
 */
export const SPAWNS_SETTLE_TICKS = 1;

/**
 * Whether every spawn is final, so features that keep away from spawns
 * (ruins) can be placed: the spawn phase ended
 * SPAWNS_SETTLE_TICKS ago or more.
 */
export function spawnsSettled(game: Game): boolean {
  return !game.inSpawnPhase() && game.ticksSinceStart() >= SPAWNS_SETTLE_TICKS;
}

/**
 * How many humans and nations the game has: the player count P that sizes
 * city-states (engine-lib WorldFeatures.ts). Tribe-type players (tribes,
 * city-states and the modes' bands) don't count.
 */
export function humanAndNationCount(game: Game): number {
  let n = 0;
  for (const p of game.allPlayers()) {
    if (p.type() === PlayerType.Human || p.type() === PlayerType.Nation) n++;
  }
  return n;
}

/** A circle a later feature keeps out of (euclidean, in tiles). */
export interface PlacementZone {
  tile: TileRef;
  radius: number;
}

/**
 * City-state discs: the pending CityStateExecutions' centers and founded
 * city-states' spawn tiles, each with its land disc's radius.
 */
export function cityStateZones(game: Game): PlacementZone[] {
  const zones: PlacementZone[] = [];
  for (const exec of game.executions()) {
    if (exec instanceof CityStateExecution) {
      zones.push({ tile: exec.centerTile(), radius: CITY_STATE_RADIUS });
    }
  }
  for (const p of game.allPlayers()) {
    const center = p.isCityState() ? p.spawnTile() : undefined;
    if (center !== undefined && !zones.some((z) => z.tile === center)) {
      zones.push({ tile: center, radius: CITY_STATE_RADIUS });
    }
  }
  return zones;
}

/** Volcano sites, with the warning ring a rumbling one puts up. */
export function volcanoZones(sites: readonly TileRef[]): PlacementZone[] {
  return sites.map((tile) => ({ tile, radius: VOLCANO_WARNING_RADIUS }));
}

/**
 * Whether a feature reaching `reach` tiles around `tile` would overlap any
 * zone: their circles touch.
 */
export function overlapsZone(
  game: Game,
  zones: readonly PlacementZone[],
  tile: TileRef,
  reach = 0,
): boolean {
  for (const z of zones) {
    const d = z.radius + reach;
    if (game.euclideanDistSquared(z.tile, tile) <= d * d) return true;
  }
  return false;
}
