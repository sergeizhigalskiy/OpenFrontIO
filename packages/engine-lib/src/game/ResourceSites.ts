import { GameMap, TileRef } from "@openfront/engine-api/game/GameMap";
import { PseudoRandom } from "../PseudoRandom";

/**
 * Resource sites: fixed spots on the map that pay whoever holds them.
 * A lobby setting (GameConfig.resourceSites).
 *
 * The rules, kept small on purpose:
 * - Sites are placed once, at game start, from the game's seed: per kind
 *   about one per `landTilesPerSite` land tiles, clamped to the kind's
 *   min/max, at least RESOURCE_SITE_MIN_DISTANCE tiles from each other and
 *   the kind's `spawnDistance` from the nations' spawn cells. Kinds are
 *   placed in RESOURCE_SITE_KINDS order from one random stream, so a kind
 *   added later never moves the ones before it.
 * - Land kinds (gold mines, oil fields) sit on passable land and are held by
 *   whoever owns their tile: taken by attacking like any land, with nothing
 *   to build. Dug out by a canal or a water nuke, they pay no one.
 * - Fishing grounds sit on ocean FISHING_GROUNDS_MIN/MAX_SHORE_DISTANCE tiles
 *   off a coast and are held by whoever owns the nearest coast tile within
 *   FISHING_GROUNDS_COAST_RADIUS, worked out from the map every time (see
 *   resourceSiteHolderTile), so they follow the coast when it changes.
 * - Each tick the holder gets the kind's goldPerTick, scaled by their gold
 *   multiplier like passive income.
 *
 * A new kind is a new entry in RESOURCE_SITE_KINDS (append only: the index
 * travels in ResourceSitesUpdate and in snapshots) and its
 * RESOURCE_SITE_INFO.
 *
 * Shared by the engine (ResourceSiteExecution places and pays them, nations
 * weigh their holders) and the client (map icons, hover and the
 * leaderboard's site columns). Every "who holds this site" question goes
 * through resourceSiteHolderTile.
 */

export enum ResourceSiteKind {
  GoldMine = "GoldMine",
  OilField = "OilField",
  FishingGrounds = "FishingGrounds",
}

/** Kinds in the order their index travels on the wire. Append only. */
export const RESOURCE_SITE_KINDS: readonly ResourceSiteKind[] = [
  ResourceSiteKind.GoldMine,
  ResourceSiteKind.OilField,
  ResourceSiteKind.FishingGrounds,
];

export interface ResourceSiteInfo {
  /** Gold per tick for the holder, before their gold multiplier. */
  goldPerTick: bigint;
  /** Translation key of the site's name. */
  nameKey: string;
  /**
   * On ocean and held through the nearest coast; otherwise on land and held
   * with its own tile.
   */
  onWater: boolean;
  /** About one site of this kind per this many land tiles... */
  landTilesPerSite: number;
  /** ...clamped to this range. */
  minSites: number;
  maxSites: number;
  /** Minimum distance (tiles) from every nation spawn cell. */
  spawnDistance: number;
}

/**
 * Three quarters of a human's base passive income (100 gold per tick, see
 * EngineConfig.goldAdditionRate): holding a mine is worth most of a second
 * worker economy.
 */
export const GOLD_MINE_GOLD_PER_TICK = 75n;
/** One and a half mines, rounded down: the reward for reaching far out. */
export const OIL_FIELD_GOLD_PER_TICK = (GOLD_MINE_GOLD_PER_TICK * 3n) / 2n;
/** A mine's worth. */
export const FISHING_GROUNDS_GOLD_PER_TICK = GOLD_MINE_GOLD_PER_TICK;

/** Gold mines: one for about this many land tiles. */
export const LAND_TILES_PER_RESOURCE_SITE = 60_000;
export const MIN_RESOURCE_SITES = 6;
export const MAX_RESOURCE_SITES = 24;
/** Oil fields and fishing grounds: one of each for about this many. */
export const LAND_TILES_PER_RARE_SITE = 180_000;
export const MIN_RARE_SITES = 2;
export const MAX_RARE_SITES = 8;
/** Minimum distance (tiles) between sites, and from nation spawn cells. */
export const RESOURCE_SITE_MIN_DISTANCE = 25;
/** Oil fields keep twice that from the spawns. */
export const OIL_FIELD_SPAWN_DISTANCE = 2 * RESOURCE_SITE_MIN_DISTANCE;
/** How far (tiles) off the nearest coast a fishing ground is placed. */
export const FISHING_GROUNDS_MIN_SHORE_DISTANCE = 3;
export const FISHING_GROUNDS_MAX_SHORE_DISTANCE = 8;
/** How far (tiles) a fishing ground looks for the coast that holds it. */
export const FISHING_GROUNDS_COAST_RADIUS = 10;

/** Random picks tried per land site wanted before placement gives up. */
const PLACEMENT_ATTEMPTS_PER_SITE = 200;
/**
 * The same for water sites, which pick from the whole map and keep only
 * ocean near a coast, so most picks miss.
 */
const WATER_PLACEMENT_ATTEMPTS_PER_SITE = 2_000;

/** How often (ticks) the engine repeats the site list for late views. */
export const RESOURCE_SITES_RESEND_TICKS = 10;

export const RESOURCE_SITE_INFO: Readonly<
  Record<ResourceSiteKind, ResourceSiteInfo>
> = {
  [ResourceSiteKind.GoldMine]: {
    goldPerTick: GOLD_MINE_GOLD_PER_TICK,
    nameKey: "resource_sites.gold_mine",
    onWater: false,
    landTilesPerSite: LAND_TILES_PER_RESOURCE_SITE,
    minSites: MIN_RESOURCE_SITES,
    maxSites: MAX_RESOURCE_SITES,
    spawnDistance: RESOURCE_SITE_MIN_DISTANCE,
  },
  [ResourceSiteKind.OilField]: {
    goldPerTick: OIL_FIELD_GOLD_PER_TICK,
    nameKey: "resource_sites.oil_field",
    onWater: false,
    landTilesPerSite: LAND_TILES_PER_RARE_SITE,
    minSites: MIN_RARE_SITES,
    maxSites: MAX_RARE_SITES,
    spawnDistance: OIL_FIELD_SPAWN_DISTANCE,
  },
  [ResourceSiteKind.FishingGrounds]: {
    goldPerTick: FISHING_GROUNDS_GOLD_PER_TICK,
    nameKey: "resource_sites.fishing_grounds",
    onWater: true,
    landTilesPerSite: LAND_TILES_PER_RARE_SITE,
    minSites: MIN_RARE_SITES,
    maxSites: MAX_RARE_SITES,
    spawnDistance: RESOURCE_SITE_MIN_DISTANCE,
  },
};

export interface ResourceSite {
  tile: TileRef;
  kind: ResourceSiteKind;
}

/** How many sites of `kind` a map with `numLandTiles` land tiles gets. */
export function resourceSiteCount(
  numLandTiles: number,
  kind: ResourceSiteKind = ResourceSiteKind.GoldMine,
): number {
  const info = RESOURCE_SITE_INFO[kind];
  const wanted = Math.round(numLandTiles / info.landTilesPerSite);
  return Math.max(info.minSites, Math.min(info.maxSites, wanted));
}

/**
 * Places the sites for a new game. Deterministic: the same map, random
 * stream and spawn cells give the same sites. Kind by kind, in
 * RESOURCE_SITE_KINDS order: picks uniformly among the tiles the kind may
 * sit on (passable land, or ocean the right distance off a coast) and
 * rejects picks too close to a placed site or a spawn cell; a map too small
 * for the full count gets as many as fit.
 */
export function placeResourceSites(
  map: GameMap,
  random: PseudoRandom,
  spawnCells: readonly { x: number; y: number }[],
  blocked: (tile: TileRef) => boolean = () => false,
): ResourceSite[] {
  const land: TileRef[] = [];
  map.forEachTile((tile) => {
    if (map.isLand(tile) && !map.isImpassable(tile)) land.push(tile);
  });
  const sites: ResourceSite[] = [];
  if (land.length === 0) return sites;

  const siteDist2 = RESOURCE_SITE_MIN_DISTANCE * RESOURCE_SITE_MIN_DISTANCE;
  const tooClose = (x: number, y: number, spawnDist2: number): boolean => {
    for (const c of spawnCells) {
      const dx = c.x - x;
      const dy = c.y - y;
      if (dx * dx + dy * dy < spawnDist2) return true;
    }
    for (const s of sites) {
      const dx = map.x(s.tile) - x;
      const dy = map.y(s.tile) - y;
      if (dx * dx + dy * dy < siteDist2) return true;
    }
    return false;
  };
  const numTiles = map.width() * map.height();
  const minShore2 =
    FISHING_GROUNDS_MIN_SHORE_DISTANCE * FISHING_GROUNDS_MIN_SHORE_DISTANCE;

  for (const kind of RESOURCE_SITE_KINDS) {
    const info = RESOURCE_SITE_INFO[kind];
    const wanted = resourceSiteCount(map.numLandTiles(), kind);
    const spawnDist2 = info.spawnDistance * info.spawnDistance;
    const attempts =
      wanted *
      (info.onWater
        ? WATER_PLACEMENT_ATTEMPTS_PER_SITE
        : PLACEMENT_ATTEMPTS_PER_SITE);
    let placed = 0;
    for (let i = 0; i < attempts && placed < wanted; i++) {
      const tile = info.onWater
        ? random.nextInt(0, numTiles)
        : land[random.nextInt(0, land.length)];
      if (info.onWater && (map.isLand(tile) || !map.isOcean(tile))) continue;
      const x = map.x(tile);
      const y = map.y(tile);
      // `blocked`: what earlier start features hold (StartPlacements).
      // Checked after the draw, so it shifts no other site.
      if (tooClose(x, y, spawnDist2) || blocked(tile)) continue;
      if (info.onWater) {
        const shore = nearestCoastTile(
          map,
          tile,
          FISHING_GROUNDS_MAX_SHORE_DISTANCE,
        );
        if (shore === null) continue;
        if (map.euclideanDistSquared(tile, shore) < minShore2) continue;
      }
      sites.push({ tile, kind });
      placed++;
    }
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

/** Whether `tile` is coast: passable land with water on a side. */
function isCoast(map: GameMap, tile: TileRef): boolean {
  if (!map.isLand(tile) || map.isImpassable(tile)) return false;
  const w = map.width();
  const x = map.x(tile);
  const y = map.y(tile);
  return (
    (x > 0 && !map.isLand(tile - 1)) ||
    (x < w - 1 && !map.isLand(tile + 1)) ||
    (y > 0 && !map.isLand(tile - w)) ||
    (y < map.height() - 1 && !map.isLand(tile + w))
  );
}

/**
 * The coast tile nearest `tile` within `radius` tiles (Euclidean), the
 * lowest TileRef on a tie, or null. Scans the (2 * radius + 1)² box.
 */
function nearestCoastTile(
  map: GameMap,
  tile: TileRef,
  radius: number,
): TileRef | null {
  const w = map.width();
  const cx = map.x(tile);
  const cy = map.y(tile);
  const minX = Math.max(0, cx - radius);
  const maxX = Math.min(w - 1, cx + radius);
  const minY = Math.max(0, cy - radius);
  const maxY = Math.min(map.height() - 1, cy + radius);
  let best: TileRef | null = null;
  let bestDist2 = radius * radius;
  // Rows top to bottom and columns left to right visit refs in increasing
  // order, so keeping only strictly nearer tiles keeps the lowest ref.
  for (let y = minY; y <= maxY; y++) {
    const dy = y - cy;
    const row = y * w;
    for (let x = minX; x <= maxX; x++) {
      const dx = x - cx;
      const d2 = dx * dx + dy * dy;
      if (d2 > bestDist2 || (d2 === bestDist2 && best !== null)) continue;
      const t = row + x;
      if (!isCoast(map, t)) continue;
      best = t;
      bestDist2 = d2;
    }
  }
  return best;
}

/**
 * The tile whose owner holds `site` right now, or null when nothing can
 * hold it. A land kind: its own tile, while it is still land. Fishing
 * grounds: the nearest coast tile within FISHING_GROUNDS_COAST_RADIUS
 * (lowest TileRef on a tie). Worked out from the map each time, never
 * stored, so it follows canals and water nukes, and the engine and the
 * client agree. The site pays no one when this tile is unowned.
 */
export function resourceSiteHolderTile(
  map: GameMap,
  site: ResourceSite,
): TileRef | null {
  if (!RESOURCE_SITE_INFO[site.kind].onWater) {
    return map.isLand(site.tile) ? site.tile : null;
  }
  if (map.isLand(site.tile)) return null;
  return nearestCoastTile(map, site.tile, FISHING_GROUNDS_COAST_RADIUS);
}

/** The small id of whoever holds `site` right now, 0 for no one. */
export function resourceSiteHolderID(map: GameMap, site: ResourceSite): number {
  const tile = resourceSiteHolderTile(map, site);
  return tile === null ? 0 : map.ownerID(tile);
}

/** Whether `site` pays anyone right now. */
export function resourceSitePays(map: GameMap, site: ResourceSite): boolean {
  return resourceSiteHolderID(map, site) !== 0;
}

/**
 * Whether `site` is still there to see: a land kind until its tile is dug
 * out, fishing grounds always (their water stays water).
 */
export function resourceSiteStands(map: GameMap, site: ResourceSite): boolean {
  if (RESOURCE_SITE_INFO[site.kind].onWater) return !map.isLand(site.tile);
  return map.isLand(site.tile);
}

/** The sites `smallID` holds right now. */
export function resourceSitesHeldBy(
  map: GameMap,
  sites: readonly ResourceSite[],
  smallID: number,
): ResourceSite[] {
  if (smallID === 0) return [];
  return sites.filter((s) => resourceSiteHolderID(map, s) === smallID);
}

/**
 * Gold per tick `sites` pay before the holder's gold multiplier (a client
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
