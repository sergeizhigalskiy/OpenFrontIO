/**
 * Volcanoes (lobby modifier, off by default): a few mountain sites that rumble
 * and then erupt on a seeded schedule.
 *
 * Shared by the engine (VolcanoExecution) and the client (warning ring, site
 * icons), so every tunable number lives here. All math is integer, so the
 * engine stays deterministic.
 */
import { GameMap, TileRef } from "@openfront/engine-api/game/GameMap";

const TICKS_PER_SECOND = 10;
const TICKS_PER_MINUTE = 60 * TICKS_PER_SECOND;

/** Tiles (euclidean) around a site that an eruption clears. */
export const VOLCANO_ERUPTION_RADIUS = 15;

/** Radius of the pulsing warning ring shown while a site rumbles. */
export const VOLCANO_WARNING_RADIUS = 25;

/** Most sites a map gets. */
export const VOLCANO_MAX_SITES = 4;

/** One more site per this many land tiles, from 1 up to VOLCANO_MAX_SITES. */
export const VOLCANO_LAND_TILES_PER_SITE = 600_000;

/** Auto-placed sites are at least this many tiles (euclidean) apart. */
export const VOLCANO_MIN_SITE_SPACING = 150;

/**
 * An auto-placed site is a local high point: no land within this many tiles
 * (square window) is higher.
 */
export const VOLCANO_PEAK_RADIUS = 8;

/** Lowest land magnitude that counts as a mountain (GameMapImpl.terrainType). */
export const VOLCANO_MOUNTAIN_MAGNITUDE = 20;

/** The first site starts rumbling this long after the spawn phase. */
export const VOLCANO_FIRST_RUMBLE_TICKS = 8 * TICKS_PER_MINUTE;

/** After a rumble starts, the next one starts this long later (seeded). */
export const VOLCANO_MIN_INTERVAL_TICKS = 8 * TICKS_PER_MINUTE;
export const VOLCANO_MAX_INTERVAL_TICKS = 12 * TICKS_PER_MINUTE;

/** How long a site rumbles (warning ring up) before it erupts. */
export const VOLCANO_WARNING_TICKS = 20 * TICKS_PER_SECOND;

/** How long the fallout an eruption leaves stays. */
export const VOLCANO_FALLOUT_TICKS = 60 * TICKS_PER_SECOND;

/** A hand-placed site from a map's info.json `volcanoes` list. */
export interface VolcanoSitePosition {
  x: number;
  y: number;
}

/** Sites a map with `numLandTiles` land tiles gets: 1 to VOLCANO_MAX_SITES. */
export function volcanoSiteCount(numLandTiles: number): number {
  const count = Math.ceil(numLandTiles / VOLCANO_LAND_TILES_PER_SITE);
  return Math.max(1, Math.min(VOLCANO_MAX_SITES, count));
}

/**
 * The game's volcano sites, chosen once at game start.
 *
 * A map that lists `volcanoes` by hand gets exactly those (on the map, without
 * repeats, at most VOLCANO_MAX_SITES). Otherwise the sites are the highest
 * mountain tiles: land is walked from the highest magnitude down, ties by tile
 * index, and a tile is taken when it is a local high point (see
 * VOLCANO_PEAK_RADIUS) at least VOLCANO_MIN_SITE_SPACING from every site taken
 * so far, until volcanoSiteCount sites are placed. A map with no mountains
 * uses its highest land instead. Pure integer work over the terrain, so every
 * client picks the same sites. `blocked` skips a site (the engine keeps
 * volcano rings off city-states, see engine/game/StartPlacements.ts).
 */
export function selectVolcanoSites(
  map: GameMap,
  manual?: readonly VolcanoSitePosition[] | null,
  blocked: (tile: TileRef) => boolean = () => false,
): TileRef[] {
  if (manual !== undefined && manual !== null && manual.length > 0) {
    const sites: TileRef[] = [];
    for (const { x, y } of manual) {
      if (!map.isValidCoord(x, y)) continue;
      const tile = map.ref(x, y);
      if (sites.includes(tile) || blocked(tile)) continue;
      sites.push(tile);
      if (sites.length === VOLCANO_MAX_SITES) break;
    }
    return sites;
  }

  const width = map.width();
  const height = map.height();
  const numTiles = width * height;
  // Passable land magnitudes run 0..30 (31 is impassable).
  const counts = new Int32Array(31);
  for (let t = 0; t < numTiles; t++) {
    if (!map.isLand(t) || map.isImpassable(t)) continue;
    counts[map.magnitude(t)]++;
  }
  let minMagnitude = VOLCANO_MOUNTAIN_MAGNITUDE;
  let hasMountains = false;
  for (let m = VOLCANO_MOUNTAIN_MAGNITUDE; m <= 30; m++) {
    if (counts[m] > 0) hasMountains = true;
  }
  if (!hasMountains) minMagnitude = 0;

  // Counting sort: highest magnitude first, then tile index.
  const offsets = new Int32Array(32);
  let total = 0;
  for (let m = 30; m >= minMagnitude; m--) {
    offsets[m] = total;
    total += counts[m];
  }
  const order = new Uint32Array(total);
  for (let t = 0; t < numTiles; t++) {
    if (!map.isLand(t) || map.isImpassable(t)) continue;
    const m = map.magnitude(t);
    if (m < minMagnitude) continue;
    order[offsets[m]++] = t;
  }

  const want = volcanoSiteCount(map.numLandTiles());
  const spacing2 = VOLCANO_MIN_SITE_SPACING * VOLCANO_MIN_SITE_SPACING;
  const sites: TileRef[] = [];
  for (let i = 0; i < order.length && sites.length < want; i++) {
    const tile = order[i];
    let farEnough = true;
    for (const site of sites) {
      if (map.euclideanDistSquared(tile, site) < spacing2) {
        farEnough = false;
        break;
      }
    }
    if (farEnough && !blocked(tile) && isLocalHighPoint(map, tile)) {
      sites.push(tile);
    }
  }
  return sites;
}

function isLocalHighPoint(map: GameMap, tile: TileRef): boolean {
  const m = map.magnitude(tile);
  const cx = map.x(tile);
  const cy = map.y(tile);
  const x0 = Math.max(0, cx - VOLCANO_PEAK_RADIUS);
  const x1 = Math.min(map.width() - 1, cx + VOLCANO_PEAK_RADIUS);
  const y0 = Math.max(0, cy - VOLCANO_PEAK_RADIUS);
  const y1 = Math.min(map.height() - 1, cy + VOLCANO_PEAK_RADIUS);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const t = map.ref(x, y);
      if (map.isLand(t) && !map.isImpassable(t) && map.magnitude(t) > m) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Every tile within `radius` (euclidean, inclusive) of `center`, in row
 * order: the eruption area, the warning area.
 */
export function tilesInRadius(
  map: GameMap,
  center: TileRef,
  radius: number,
): TileRef[] {
  const cx = map.x(center);
  const cy = map.y(center);
  const r2 = radius * radius;
  const x0 = Math.max(0, cx - radius);
  const x1 = Math.min(map.width() - 1, cx + radius);
  const y0 = Math.max(0, cy - radius);
  const y1 = Math.min(map.height() - 1, cy + radius);
  const out: TileRef[] = [];
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      if (dx * dx + dy * dy <= r2) out.push(map.ref(x, y));
    }
  }
  return out;
}

/**
 * Troops a player loses with land taken by an eruption or a flood: their
 * troops per tile times the tiles lost, floored. `tilesBefore` is what they
 * held before the event.
 */
export function troopsLostWithLand(
  troops: number,
  tilesBefore: number,
  tilesLost: number,
): number {
  if (tilesBefore <= 0 || tilesLost <= 0 || troops <= 0) return 0;
  const lost = Math.min(tilesLost, tilesBefore);
  return Math.floor((troops * lost) / tilesBefore);
}
