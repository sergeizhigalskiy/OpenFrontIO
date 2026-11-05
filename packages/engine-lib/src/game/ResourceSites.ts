import { GameMap, TileRef } from "@openfront/engine-api/game/GameMap";
import { PseudoRandom } from "../PseudoRandom";

/**
 * Resource sites: fixed spots on the map that pay whoever holds their tile.
 * A lobby setting (GameConfig.resourceSites).
 *
 * The rules, kept small on purpose:
 * - Sites are placed once, at game start, from the game's seed: about one per
 *   LAND_TILES_PER_RESOURCE_SITE land tiles, clamped to MIN/MAX, on passable
 *   land, at least RESOURCE_SITE_MIN_DISTANCE tiles from each other and from
 *   the nations' spawn cells.
 * - Whoever owns a site's tile owns the site: it is taken by attacking like
 *   any land, with nothing to build. Each tick the owner gets the kind's
 *   goldPerTick, scaled by their gold multiplier like passive income.
 * - A site on a tile that is no longer land (a canal or a water nuke dug it
 *   out) pays no one.
 *
 * Only gold mines exist so far. A new kind is a new entry in
 * RESOURCE_SITE_KINDS (append only: the index travels in
 * ResourceSitesUpdate) and its RESOURCE_SITE_INFO. Placement and income treat
 * every kind alike.
 *
 * Shared by the engine (ResourceSiteExecution places and pays them) and the
 * client (map icons, hover and the leaderboard's mine columns).
 */

export enum ResourceSiteKind {
  GoldMine = "GoldMine",
}

/** Kinds in the order their index travels on the wire. Append only. */
export const RESOURCE_SITE_KINDS: readonly ResourceSiteKind[] = [
  ResourceSiteKind.GoldMine,
];

export interface ResourceSiteInfo {
  /** Gold per tick for the owner, before their gold multiplier. */
  goldPerTick: bigint;
  /** Translation key of the site's name. */
  nameKey: string;
}

/**
 * Three quarters of a human's base passive income (100 gold per tick, see
 * EngineConfig.goldAdditionRate): holding a mine is worth most of a second
 * worker economy.
 */
export const GOLD_MINE_GOLD_PER_TICK = 75n;

export const RESOURCE_SITE_INFO: Readonly<
  Record<ResourceSiteKind, ResourceSiteInfo>
> = {
  [ResourceSiteKind.GoldMine]: {
    goldPerTick: GOLD_MINE_GOLD_PER_TICK,
    nameKey: "resource_sites.gold_mine",
  },
};

/** One site for about this many land tiles. */
export const LAND_TILES_PER_RESOURCE_SITE = 60_000;
export const MIN_RESOURCE_SITES = 6;
export const MAX_RESOURCE_SITES = 24;
/** Minimum distance (tiles) between sites, and from nation spawn cells. */
export const RESOURCE_SITE_MIN_DISTANCE = 25;
/** Random picks tried per site wanted before placement gives up. */
const PLACEMENT_ATTEMPTS_PER_SITE = 200;

/** How often (ticks) the engine repeats the site list for late views. */
export const RESOURCE_SITES_RESEND_TICKS = 10;

export interface ResourceSite {
  tile: TileRef;
  kind: ResourceSiteKind;
}

/** How many sites a map with `numLandTiles` land tiles gets. */
export function resourceSiteCount(numLandTiles: number): number {
  const wanted = Math.round(numLandTiles / LAND_TILES_PER_RESOURCE_SITE);
  return Math.max(MIN_RESOURCE_SITES, Math.min(MAX_RESOURCE_SITES, wanted));
}

/**
 * Places the sites for a new game. Deterministic: the same map, random
 * stream and spawn cells give the same sites. Picks uniformly among passable
 * land tiles and rejects picks too close to a placed site or a spawn cell; a
 * map too small for the full count gets as many as fit.
 */
export function placeResourceSites(
  map: GameMap,
  random: PseudoRandom,
  spawnCells: readonly { x: number; y: number }[],
): ResourceSite[] {
  const land: TileRef[] = [];
  map.forEachTile((tile) => {
    if (map.isLand(tile) && !map.isImpassable(tile)) land.push(tile);
  });
  const sites: ResourceSite[] = [];
  if (land.length === 0) return sites;

  const wanted = resourceSiteCount(map.numLandTiles());
  const minDist2 = RESOURCE_SITE_MIN_DISTANCE * RESOURCE_SITE_MIN_DISTANCE;
  const tooClose = (x: number, y: number): boolean => {
    for (const c of spawnCells) {
      const dx = c.x - x;
      const dy = c.y - y;
      if (dx * dx + dy * dy < minDist2) return true;
    }
    for (const s of sites) {
      const dx = map.x(s.tile) - x;
      const dy = map.y(s.tile) - y;
      if (dx * dx + dy * dy < minDist2) return true;
    }
    return false;
  };

  const attempts = wanted * PLACEMENT_ATTEMPTS_PER_SITE;
  for (let i = 0; i < attempts && sites.length < wanted; i++) {
    const tile = land[random.nextInt(0, land.length)];
    if (tooClose(map.x(tile), map.y(tile))) continue;
    sites.push({ tile, kind: ResourceSiteKind.GoldMine });
  }
  return sites;
}

/** Packs sites for ResourceSitesUpdate.sites. */
export function packResourceSites(sites: readonly ResourceSite[]): number[] {
  const packed: number[] = [];
  for (const s of sites) {
    packed.push(s.tile, RESOURCE_SITE_KINDS.indexOf(s.kind));
  }
  return packed;
}

/** Reverses packResourceSites; unknown kinds (a newer engine) are skipped. */
export function unpackResourceSites(packed: readonly number[]): ResourceSite[] {
  const sites: ResourceSite[] = [];
  for (let i = 0; i + 1 < packed.length; i += 2) {
    const kind = RESOURCE_SITE_KINDS[packed[i + 1]];
    if (kind !== undefined) sites.push({ tile: packed[i], kind });
  }
  return sites;
}

/**
 * Whether a site on `tile` pays right now: only a land tile can be owned.
 * The owner itself is the tile's owner.
 */
export function resourceSitePays(map: GameMap, tile: TileRef): boolean {
  return map.isLand(tile) && map.hasOwner(tile);
}

/** The sites `smallID` holds right now. */
export function resourceSitesHeldBy(
  map: GameMap,
  sites: readonly ResourceSite[],
  smallID: number,
): ResourceSite[] {
  return sites.filter(
    (s) => map.isLand(s.tile) && map.ownerID(s.tile) === smallID,
  );
}

/**
 * Gold per tick `sites` pay before the owner's gold multiplier (a client
 * that shows a rate multiplies it by the game's multiplier itself).
 */
export function resourceSitesGoldPerTick(
  sites: readonly ResourceSite[],
): bigint {
  let gold = 0n;
  for (const s of sites) gold += RESOURCE_SITE_INFO[s.kind].goldPerTick;
  return gold;
}

/**
 * The site within `radius` tiles (Chebyshev) of `tile`, nearest first, or
 * null. For hover: a site's icon covers a few tiles around it.
 */
export function resourceSiteNear(
  map: GameMap,
  sites: readonly ResourceSite[],
  tile: TileRef,
  radius: number,
): ResourceSite | null {
  const x = map.x(tile);
  const y = map.y(tile);
  let best: ResourceSite | null = null;
  let bestDist = Infinity;
  for (const s of sites) {
    const dx = Math.abs(map.x(s.tile) - x);
    const dy = Math.abs(map.y(s.tile) - y);
    if (dx > radius || dy > radius) continue;
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      best = s;
      bestDist = dist;
    }
  }
  return best;
}
