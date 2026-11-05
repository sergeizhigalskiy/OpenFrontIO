/**
 * Zombie plague rules, shared by the sim (PlagueExecution, AttackExecution,
 * WinCheckExecution, the nation AI), the rules Config and the client HUD.
 *
 * At the spawn phase end plus PLAGUE_OUTBREAK_DELAY_TICKS a single hostile
 * bot, The Infected, breaks out as a disc of land far from every spawn. It
 * never allies and never regrows troops: it only grows by infecting.
 *  - Every tile it takes in battle from a player raises half of that
 *    player's troops-per-tile as zombies on its side.
 *  - Every PLAGUE_INTERVAL_TICKS each player bordering infected land loses a
 *    share of its troops to it, by how long the shared border is (capped).
 *  - Its own pool decays a little every interval, so starved pockets wither.
 * It attacks every neighbour with its whole pool. Killing it ends the plague
 * (the living player with the most land wins); letting it hold
 * PLAGUE_WORLD_LOSS_PERCENT of the land loses the game for everyone.
 *
 * Rates are in basis points (100 = 1%) and applied with integer math. Times
 * are in ticks (10 a second).
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

/** The outbreak happens this long after the spawn phase ends: 2 minutes. */
export const PLAGUE_OUTBREAK_DELAY_TICKS = 2 * 60 * 10;
/** The outbreak is a disc of land of this radius. */
export const PLAGUE_OUTBREAK_RADIUS = 10;
/** The outbreak's centre lies at least this far from every spawn tile. */
export const PLAGUE_MIN_SPAWN_DISTANCE = 60;
/** Random tiles tried for the outbreak's centre. */
export const PLAGUE_OUTBREAK_PLACEMENT_TRIES = 2_000;
/** The Infected's troops at the outbreak. */
export const PLAGUE_START_TROOPS = 30_000;

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
/** The Infected sends its pool across its borders every this many ticks. */
export const PLAGUE_SPREAD_INTERVAL_TICKS = 50;

/** Everyone loses once The Infected holds this share of the map's land. */
export const PLAGUE_WORLD_LOSS_PERCENT = 70;

/** The Infected (works on engine players and client views alike). */
export function isInfected(player: { id(): string | null }): boolean {
  return player.id() === INFECTED_PLAYER_ID;
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

/**
 * The outbreak's centre: a random passable land tile at least
 * PLAGUE_MIN_SPAWN_DISTANCE from every spawn tile, from `random`. When no try
 * finds one (a small or crowded map), the try that came farthest from every
 * spawn. Null only when no try lands on passable land at all.
 */
export function pickOutbreakCenter(
  map: GameMap,
  random: PseudoRandom,
  spawnTiles: readonly TileRef[],
): TileRef | null {
  const minDist2 = PLAGUE_MIN_SPAWN_DISTANCE * PLAGUE_MIN_SPAWN_DISTANCE;
  let best: TileRef | null = null;
  let bestDist2 = -1;
  for (let i = 0; i < PLAGUE_OUTBREAK_PLACEMENT_TRIES; i++) {
    const tile = map.ref(
      random.nextInt(0, map.width()),
      random.nextInt(0, map.height()),
    );
    if (!map.isLand(tile) || map.isImpassable(tile)) continue;
    let nearest2 = Number.MAX_SAFE_INTEGER;
    for (const spawn of spawnTiles) {
      const d2 = map.euclideanDistSquared(tile, spawn);
      if (d2 < nearest2) nearest2 = d2;
    }
    if (nearest2 >= minDist2) return tile;
    if (nearest2 > bestDist2) {
      best = tile;
      bestDist2 = nearest2;
    }
  }
  return best;
}

/** The passable land within PLAGUE_OUTBREAK_RADIUS of `center`, row by row. */
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
      if (map.isLand(tile) && !map.isImpassable(tile)) tiles.push(tile);
    }
  }
  return tiles;
}
