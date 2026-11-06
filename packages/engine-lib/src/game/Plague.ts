/**
 * Zombie plague rules, shared by the sim (PlagueExecution, AttackExecution,
 * WinCheckExecution, the nation AI), the rules Config and the client HUD.
 *
 * PLAGUE_OUTBREAK_DELAY_TICKS after the spawn phase a single hostile bot, The
 * Infected, breaks out on free land far from every spawn, with a share of the
 * strongest player's troops (two sites when the game is big). It never allies
 * and never regrows troops: it only grows by infecting.
 *  - Every tile it takes in battle from a player raises half of that
 *    player's troops-per-tile as zombies on its side.
 *  - Every PLAGUE_INTERVAL_TICKS each player bordering infected land loses a
 *    share of its troops to it, by how long the shared border is (capped).
 *  - Its own pool decays a little every interval, so starved pockets wither.
 * It sends half its pool at its neighbours every PLAGUE_SPREAD_INTERVAL_TICKS
 * and keeps the rest as a garrison.
 *
 * Killing it never ends the game: whoever takes its last tile is paid for
 * the cure, and if that happens early it breaks out again, stronger, up to
 * PLAGUE_MAX_OUTBREAKS times. Letting it hold PLAGUE_WORLD_LOSS_PERCENT of the
 * land loses the game for everyone.
 *
 * Rates are in basis points (100 = 1%) and applied with integer math. Times
 * are in ticks since the spawn phase ended (10 a second).
 */
import type { GameMap, TileRef } from "@openfront/engine-api/game/GameMap";
import type { Team } from "@openfront/engine-api/game/GameTypes";
import { PseudoRandom } from "../PseudoRandom";

/**
 * The Infected's player id: fixed, so rules that only see an id (the troop
 * growth in Config, the client's colours) can tell it apart. Eight
 * characters, like every generated id.
 */
export const INFECTED_PLAYER_ID = "infected";
/** The Infected's name on the map. */
export const INFECTED_NAME = "The Infected";
/**
 * The winner recorded when the plague consumes the world: a team nobody is
 * on, so no player is credited and everyone loses.
 */
export const INFECTED_TEAM: Team = "Infected";

/** The first outbreak happens this long after the spawn phase ends: 4:00. */
export const PLAGUE_OUTBREAK_DELAY_TICKS = 4 * 60 * 10;
/** An outbreak site is a disc of free land of this radius. */
export const PLAGUE_OUTBREAK_RADIUS = 10;
/** An outbreak's centre lies at least this far from every spawn. */
export const PLAGUE_MIN_SPAWN_DISTANCE = 60;
/** Random free tiles tried for an outbreak's centre. */
export const PLAGUE_OUTBREAK_PLACEMENT_TRIES = 2_000;
/** Centres at the distance compared, for the one with the most free land. */
export const PLAGUE_OUTBREAK_CANDIDATES = 32;
/** With no free land at all, the outbreak is tried again this often. */
export const PLAGUE_OUTBREAK_RETRY_TICKS = 100;
/** The first outbreak's troops: this percent of the strongest player's ... */
export const PLAGUE_START_TROOPS_PERCENT = 75;
/** ... and never fewer than this. */
export const PLAGUE_MIN_START_TROOPS = 30_000;
/** At this many humans and nations, an outbreak splits over two sites. */
export const PLAGUE_TWO_SITES_MIN_PLAYERS = 6;

/** Wiped out before this, The Infected breaks out again: 20:00. */
export const PLAGUE_COMEBACK_BEFORE_TICKS = 20 * 60 * 10;
/** The next outbreak comes this long after the last one is wiped out. */
export const PLAGUE_COMEBACK_DELAY_TICKS = 3 * 60 * 10;
/** Each comeback starts with this percent of the previous start's troops. */
export const PLAGUE_COMEBACK_TROOPS_PERCENT = 150;
/** At most this many outbreaks in a game. */
export const PLAGUE_MAX_OUTBREAKS = 3;

/** Whoever takes The Infected's last tile gets this much gold per outbreak number ... */
export const PLAGUE_CURE_GOLD = 500_000;
/** ... and this much more troop growth ... */
export const PLAGUE_CURE_GROWTH_PERCENT = 25;
/** ... for this long. */
export const PLAGUE_CURE_GROWTH_TICKS = 2 * 60 * 10;

/** Share of a defender's troops-per-tile that rises as zombies per tile taken. */
export const PLAGUE_CAPTURE_CONVERSION_PERCENT = 50;

/** Contact infection and decay run every this many ticks. */
export const PLAGUE_INTERVAL_TICKS = 10;
/** Contact infection per 100 border tiles shared with The Infected: 0.5%. */
export const PLAGUE_CONTACT_BPS_PER_100_TILES = 50;
/** Contact infection never takes more than 3% per interval. */
export const PLAGUE_CONTACT_MAX_BPS = 300;
/** The Infected's pool decays 0.2% per interval. */
export const PLAGUE_DECAY_BPS = 20;
/** The Infected sends part of its pool across its borders this often ... */
export const PLAGUE_SPREAD_INTERVAL_TICKS = 50;
/** ... this percent of it, keeping the rest home. */
export const PLAGUE_SPREAD_PERCENT = 50;

/** Everyone loses once The Infected holds this share of the map's land. */
export const PLAGUE_WORLD_LOSS_PERCENT = 70;

/** The Infected (works on engine players and client views alike). */
export function isInfected(player: { id(): string | null }): boolean {
  return player.id() === INFECTED_PLAYER_ID;
}

/** The first outbreak's troops, from the strongest player's troops. */
export function plagueStartTroops(strongestTroops: number): number {
  return Math.max(
    PLAGUE_MIN_START_TROOPS,
    Math.floor((strongestTroops * PLAGUE_START_TROOPS_PERCENT) / 100),
  );
}

/** A comeback outbreak's troops, from the previous outbreak's start. */
export function plagueComebackTroops(previousStart: number): number {
  return Math.floor((previousStart * PLAGUE_COMEBACK_TROOPS_PERCENT) / 100);
}

/**
 * Whether The Infected breaks out again after outbreak `outbreak` (1-based)
 * was wiped out `ticksSinceStart` ticks into the game.
 */
export function plagueComesBack(
  outbreak: number,
  ticksSinceStart: number,
): boolean {
  return (
    outbreak < PLAGUE_MAX_OUTBREAKS &&
    ticksSinceStart < PLAGUE_COMEBACK_BEFORE_TICKS
  );
}

/** How many sites an outbreak splits over, by the humans and nations alive. */
export function plagueSiteCount(players: number): number {
  return players >= PLAGUE_TWO_SITES_MIN_PLAYERS ? 2 : 1;
}

/** The cure's gold for outbreak `outbreak` at `goldMultiplier`. */
export function plagueCureGold(
  outbreak: number,
  goldMultiplier: number,
): bigint {
  return BigInt(Math.floor(PLAGUE_CURE_GOLD * outbreak * goldMultiplier));
}

/** Spread: the troops The Infected sends out of a pool of `troops`. */
export function plagueSpreadTroops(troops: number): number {
  return Math.floor((troops * PLAGUE_SPREAD_PERCENT) / 100);
}

/**
 * Zombies raised when The Infected takes one tile from a player that holds
 * `troops` over `tiles`: half the player's troops-per-tile, floored.
 */
export function plagueCaptureTroops(troops: number, tiles: number): number {
  if (tiles <= 0 || troops <= 0) return 0;
  return Math.floor(
    (troops * PLAGUE_CAPTURE_CONVERSION_PERCENT) / (100 * tiles),
  );
}

/**
 * The contact infection rate, in basis points per interval, for a player
 * sharing `sharedTiles` border tiles with The Infected: 0.5% per 100 tiles,
 * pro rata, capped at 3%.
 */
export function contactInfectionBps(sharedTiles: number): number {
  return Math.min(
    PLAGUE_CONTACT_MAX_BPS,
    Math.floor((sharedTiles * PLAGUE_CONTACT_BPS_PER_100_TILES) / 100),
  );
}

/** Troops a player holding `troops` loses to contact infection this interval. */
export function contactInfectionLoss(
  troops: number,
  sharedTiles: number,
): number {
  return Math.floor((troops * contactInfectionBps(sharedTiles)) / 10_000);
}

/** What `troops` of The Infected's pool lose to decay this interval. */
export function plagueDecay(troops: number): number {
  return Math.floor((troops * PLAGUE_DECAY_BPS) / 10_000);
}

/** Whether The Infected holds enough of the land for everyone to lose. */
export function plagueConsumedWorld(
  infectedTiles: number,
  landTiles: number,
): boolean {
  return (
    landTiles > 0 &&
    infectedTiles * 100 >= landTiles * PLAGUE_WORLD_LOSS_PERCENT
  );
}

/** The Infected's share of the land in percent, for the HUD meter. */
export function infectedLandPercent(
  infectedTiles: number,
  landTiles: number,
): number {
  return landTiles > 0 ? (infectedTiles * 100) / landTiles : 0;
}

/** Whether `tile` is free land an outbreak may take: unowned and passable. */
export function isOutbreakLand(map: GameMap, tile: TileRef): boolean {
  return (
    map.isLand(tile) &&
    !map.isImpassable(tile) &&
    map.ownerID(tile) === 0 &&
    !map.hasFallout(tile)
  );
}

/** Squared distance from `tile` to the nearest of `points`. */
function nearestDist2(
  map: GameMap,
  tile: TileRef,
  points: readonly TileRef[],
): number {
  let nearest = Number.MAX_SAFE_INTEGER;
  for (const p of points) {
    const d = map.euclideanDistSquared(tile, p);
    if (d < nearest) nearest = d;
  }
  return nearest;
}

/**
 * An outbreak's centre, from `random`: free land (isOutbreakLand) at least
 * PLAGUE_MIN_SPAWN_DISTANCE from every spawn and earlier site in `avoid`.
 * Of up to PLAGUE_OUTBREAK_CANDIDATES such tiles it takes the one whose disc
 * holds the most free land. When no free tile is that far, the free tile
 * farthest from all of them (`farEnough` false). Null when no land is free.
 */
export function pickOutbreakCenter(
  map: GameMap,
  random: PseudoRandom,
  avoid: readonly TileRef[],
): { tile: TileRef; farEnough: boolean } | null {
  const free: TileRef[] = [];
  map.forEachTile((tile) => {
    if (isOutbreakLand(map, tile)) free.push(tile);
  });
  if (free.length === 0) return null;
  const minDist2 = PLAGUE_MIN_SPAWN_DISTANCE * PLAGUE_MIN_SPAWN_DISTANCE;
  let best: TileRef | null = null;
  let bestLand = -1;
  let found = 0;
  for (
    let i = 0;
    i < PLAGUE_OUTBREAK_PLACEMENT_TRIES && found < PLAGUE_OUTBREAK_CANDIDATES;
    i++
  ) {
    const tile = free[random.nextInt(0, free.length)];
    if (nearestDist2(map, tile, avoid) < minDist2) continue;
    found++;
    const land = outbreakTiles(map, tile).length;
    if (land > bestLand) {
      best = tile;
      bestLand = land;
    }
  }
  if (best !== null) return { tile: best, farEnough: true };
  // Nothing far enough was drawn: the farthest free tile of all.
  let farthest = free[0];
  let farthestDist2 = -1;
  for (const tile of free) {
    const d = nearestDist2(map, tile, avoid);
    if (d > farthestDist2) {
      farthest = tile;
      farthestDist2 = d;
    }
  }
  return { tile: farthest, farEnough: farthestDist2 >= minDist2 };
}

/** The free land (isOutbreakLand) within PLAGUE_OUTBREAK_RADIUS of `center`, row by row. */
export function outbreakTiles(map: GameMap, center: TileRef): TileRef[] {
  const r = PLAGUE_OUTBREAK_RADIUS;
  const cx = map.x(center);
  const cy = map.y(center);
  const tiles: TileRef[] = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (!map.isValidCoord(x, y)) continue;
      const tile = map.ref(x, y);
      if (isOutbreakLand(map, tile)) tiles.push(tile);
    }
  }
  return tiles;
}
