import { GameMap, TileRef } from "@openfront/engine-api/game/GameMap";
import { PlayerType } from "@openfront/engine-api/game/GameTypes";
import { PseudoRandom } from "../PseudoRandom";

/**
 * Resource sites: fixed spots on the map that pay whoever holds them.
 * A lobby setting (GameConfig.resourceSites).
 *
 * The rules, kept small on purpose:
 * - Sites are placed once, when the spawn phase ends, from the game's seed,
 *   so nobody sees them while picking a spawn. How many comes from the
 *   number of players (humans and nations), not the map's size, so the pool
 *   is about the same share of each player's base income on every map (see
 *   resourceSiteCount). Each sits at least RESOURCE_SITE_MIN_DISTANCE tiles
 *   from the others and RESOURCE_SITE_SPAWN_DISTANCE from every human and
 *   nation spawn. Kinds are placed in RESOURCE_SITE_KINDS order from one
 *   random stream, so a kind added later never moves the ones before it.
 * - Land kinds (gold mines, oil fields) sit on passable land and are held by
 *   whoever owns their tile: taken by attacking like any land, with nothing
 *   to build. Flooded by the rising tide or a water nuke, they pay no one.
 * - Fishing grounds sit on ocean FISHING_GROUNDS_MIN/MAX_SHORE_DISTANCE tiles
 *   off a coast and are held by whoever owns the nearest coast tile within
 *   FISHING_GROUNDS_COAST_RADIUS, worked out from the map every time (see
 *   resourceSiteHolderTile), so they follow the coast when it changes.
 * - From RESOURCE_SITE_FIRST_PAY_TICKS after the spawn phase, each tick pays
 *   every human or nation holder for their best
 *   RESOURCE_SITES_PAID_PER_PLAYER sites (resourceSitesGoldPerTick), scaled
 *   by their gold multiplier like passive income. Holding more still keeps
 *   them from everyone else. Tribes and city-states are never paid
 *   (paidByResourceSites).
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
}

/**
 * 0.3x a human's base income (100 gold per tick, see
 * EngineConfig.goldAdditionRate).
 */
export const GOLD_MINE_GOLD_PER_TICK = 30n;
/** 0.45x base income: the reward for reaching the rarer kind. */
export const OIL_FIELD_GOLD_PER_TICK = 45n;
/** A mine's worth. */
export const FISHING_GROUNDS_GOLD_PER_TICK = GOLD_MINE_GOLD_PER_TICK;

/**
 * Each player is paid for at most this many of the sites they hold, their
 * best ones: an oil field and two mines are 1.2x base income.
 */
export const RESOURCE_SITES_PAID_PER_PLAYER = 3;

/** Gold mines: one per this many players (humans and nations)... */
export const PLAYERS_PER_GOLD_MINE = 4;
/** ...clamped to this range. */
export const MIN_GOLD_MINES = 2;
export const MAX_GOLD_MINES = 10;
/**
 * Oil fields, and fishing grounds on a map with ocean: one of each per this
 * many players...
 */
export const PLAYERS_PER_RARE_SITE = 12;
/** ...clamped to this range. */
export const MIN_RARE_SITES = 1;
export const MAX_RARE_SITES = 3;
/** A map with no ocean gets this many more gold mines instead of fishing. */
export const EXTRA_GOLD_MINES_WITHOUT_OCEAN = 1;

/** Minimum distance (tiles) between sites. */
export const RESOURCE_SITE_MIN_DISTANCE = 25;
/** Minimum distance (tiles) from every human and nation spawn. */
export const RESOURCE_SITE_SPAWN_DISTANCE = 40;
/** Sites first pay this many ticks after the spawn phase ends (60 s). */
export const RESOURCE_SITE_FIRST_PAY_TICKS = 600;
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
  },
  [ResourceSiteKind.OilField]: {
    goldPerTick: OIL_FIELD_GOLD_PER_TICK,
    nameKey: "resource_sites.oil_field",
    onWater: false,
  },
  [ResourceSiteKind.FishingGrounds]: {
    goldPerTick: FISHING_GROUNDS_GOLD_PER_TICK,
    nameKey: "resource_sites.fishing_grounds",
    onWater: true,
  },
};

export interface ResourceSite {
  tile: TileRef;
  kind: ResourceSiteKind;
}

/**
 * How many sites of `kind` a game with `players` humans and nations gets:
 * gold mines one per PLAYERS_PER_GOLD_MINE (2 to 10), oil fields one per
 * PLAYERS_PER_RARE_SITE (1 to 3), fishing grounds as many as oil fields when
 * the map has ocean, otherwise EXTRA_GOLD_MINES_WITHOUT_OCEAN more mines.
 */
export function resourceSiteCount(
  players: number,
  kind: ResourceSiteKind,
  hasOcean: boolean,
): number {
  const rare = clamp(
    Math.round(players / PLAYERS_PER_RARE_SITE),
    MIN_RARE_SITES,
    MAX_RARE_SITES,
  );
  switch (kind) {
    case ResourceSiteKind.GoldMine:
      return (
        clamp(
          Math.round(players / PLAYERS_PER_GOLD_MINE),
          MIN_GOLD_MINES,
          MAX_GOLD_MINES,
        ) + (hasOcean ? 0 : EXTRA_GOLD_MINES_WITHOUT_OCEAN)
      );
    case ResourceSiteKind.OilField:
      return rare;
    case ResourceSiteKind.FishingGrounds:
      return hasOcean ? rare : 0;
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Whether `map` has any ocean (lakes don't count): fishing grounds' water. */
export function mapHasOcean(map: GameMap): boolean {
  const numTiles = map.width() * map.height();
  for (let tile = 0; tile < numTiles; tile++) {
    if (map.isOcean(tile)) return true;
  }
  return false;
}

/**
 * Places the sites for a game with `players` humans and nations.
 * Deterministic: the same map, random stream, player count and spawns give
 * the same sites. Kind by kind, in RESOURCE_SITE_KINDS order: picks
 * uniformly among the tiles the kind may sit on (passable land, or ocean the
 * right distance off a coast) and rejects picks too close to a placed site
 * or a spawn; a map too small for the full count gets as many as fit.
 */
export function placeResourceSites(
  map: GameMap,
  random: PseudoRandom,
  players: number,
  spawns: readonly { x: number; y: number }[],
  blocked: (tile: TileRef) => boolean = () => false,
): ResourceSite[] {
  const land: TileRef[] = [];
  map.forEachTile((tile) => {
    if (map.isLand(tile) && !map.isImpassable(tile)) land.push(tile);
  });
  const sites: ResourceSite[] = [];
  if (land.length === 0) return sites;
  const hasOcean = mapHasOcean(map);

  const siteDist2 = RESOURCE_SITE_MIN_DISTANCE * RESOURCE_SITE_MIN_DISTANCE;
  const spawnDist2 =
    RESOURCE_SITE_SPAWN_DISTANCE * RESOURCE_SITE_SPAWN_DISTANCE;
  const tooClose = (x: number, y: number): boolean => {
    for (const c of spawns) {
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
    const wanted = resourceSiteCount(players, kind, hasOcean);
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
      if (tooClose(x, y) || blocked(tile)) continue;
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
 * stored, so it follows the rising tide and water nukes, and the engine
 * and the client agree. The site pays no one when this tile is unowned.
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
 * Whether a player of `type` is paid for the sites it holds: humans and
 * nations are; tribes and city-states (and every other tribe-type player)
 * never are, so a site under their land pays no one.
 */
export function paidByResourceSites(type: PlayerType): boolean {
  return type === PlayerType.Human || type === PlayerType.Nation;
}

/**
 * Gold per tick `sites`, all held by one player, pay that player before
 * their gold multiplier (a client that shows a rate multiplies it by the
 * game's multiplier itself): their best RESOURCE_SITES_PAID_PER_PLAYER.
 */
export function resourceSitesGoldPerTick(
  sites: readonly ResourceSite[],
): bigint {
  const rates = sites
    .map((s) => RESOURCE_SITE_INFO[s.kind].goldPerTick)
    .sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  let gold = 0n;
  for (const rate of rates.slice(0, RESOURCE_SITES_PAID_PER_PLAYER)) {
    gold += rate;
  }
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
