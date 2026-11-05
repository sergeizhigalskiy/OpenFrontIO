import { TileRef } from "@openfront/engine-api/game/GameMap";
import { VOLCANO_WARNING_RADIUS } from "@openfront/engine-lib/game/Volcanoes";
import { CITY_STATE_RADIUS } from "@openfront/engine-lib/game/WorldFeatures";
import { CityStateExecution } from "../execution/CityStateExecution";
import { Game } from "./Game";

/**
 * The features placed at game start share the map in a fixed order:
 * city-states, then volcanoes, then gold mines, then ruins. Each one keeps
 * clear of the zones of those placed before it, so a mine never sits inside
 * a city-state's disc, a volcano's warning ring never reaches one, and a ruin
 * never lands on a mine.
 *
 * Each placer already runs in that order (city-states in GameRunner.init,
 * volcanoes and mines when their executions start at tick 0, ruins when the
 * spawn phase ends), and every zone is read off the game: the pending or
 * founded city-states, the volcano execution's sites and the mine
 * execution's sites. So a restored game places exactly what the original
 * did, and none of this needs a snapshot of its own. (The volcano and mine
 * sites come from VolcanoExecution's volcanoSitesOf and
 * ResourceSiteExecution's resourceSitesOf; the placers pass them in, which
 * keeps this module free of import cycles.)
 */

/** A circle a later feature keeps out of (euclidean, in tiles). */
export interface PlacementZone {
  tile: TileRef;
  radius: number;
}

/** A mine's own clearance: nothing placed later lands on or next to one. */
export const MINE_KEEP_OUT_RADIUS = 2;

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

/** Gold mines, with a small clearance. */
export function mineZones(
  sites: readonly { tile: TileRef }[],
): PlacementZone[] {
  return sites.map((site) => ({ tile: site.tile, radius: MINE_KEEP_OUT_RADIUS }));
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
