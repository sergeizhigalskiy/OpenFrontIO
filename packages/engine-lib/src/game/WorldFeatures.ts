/**
 * World features: ruins with loot and neutral city-states.
 *
 * Two lobby settings, GameConfig.ruins and GameConfig.cityStates, both on
 * unless set to false (and always off in the onboarding tutorial).
 *
 * Ruins sit on unclaimed land. They are placed when the spawn phase ends, and
 * the first player to take a ruin's tile from unclaimed land gets its reward,
 * which consumes it. The reward is rolled when the ruin is placed.
 *
 * A city-state is a tribe (PlayerType.Bot) that never expands, attacks,
 * allies, trades or takes donations. It starts with a disc of land around a
 * level-2 city and a defense post next to the city, and a dense garrison.
 * Attackers get no tribe discount against it, and it falls only below
 * CITY_STATE_ELIMINATION_TILES. Whoever eliminates it gets a gold bounty on
 * top of the normal conquest gold, and captures the city at
 * CITY_STATE_CAPTURED_CITY_LEVEL, whose troop bonus then counts for them.
 *
 * Shared by the engine (placement, rewards, troop cap) and the client (hover
 * and labels), so every tunable number lives here. All math is integer, so
 * the engine stays deterministic.
 */

// ---------------------------------------------------------------------------
// Ruins
// ---------------------------------------------------------------------------

/** Fewest ruins a map gets (when there is room for them). */
export const RUINS_MIN_COUNT = 15;

/** Most ruins a map gets. */
export const RUINS_MAX_COUNT = 30;

/** One ruin per this many land tiles, clamped to the counts above. */
export const LAND_TILES_PER_RUIN = 80_000;

/** A ruin is at least this many tiles (euclidean) from every spawn tile. */
export const RUIN_MIN_SPAWN_DISTANCE = 25;

/** ...and at least this many tiles from every other ruin. */
export const RUIN_MIN_SPACING = 25;

/** Gold a gold burst pays. */
export const RUIN_GOLD_REWARD = 150_000;

/** A troop burst adds this percent of the claimer's max troops. */
export const RUIN_TROOP_REWARD_PERCENT = 10;

/** What a ruin holds. Rolled when it is placed, hidden until claimed. */
export enum RuinReward {
  Gold = 0,
  Troops = 1,
  /**
   * A free level-1 defense post on the ruin tile, built at once. A gold burst
   * instead when no structure can go there.
   */
  DefensePost = 2,
}

/** How many RuinReward kinds a roll picks from (all equally likely). */
export const RUIN_REWARD_KINDS = 3;

/** Placement tries per ruin before the placer settles for fewer. */
export const RUIN_PLACEMENT_TRIES_PER_RUIN = 400;

/** How many ruins a map with `landTiles` land tiles gets. */
export function ruinCount(landTiles: number): number {
  return clampCount(
    Math.floor(landTiles / LAND_TILES_PER_RUIN),
    RUINS_MIN_COUNT,
    RUINS_MAX_COUNT,
  );
}

/**
 * Troops a troop burst adds to a player holding `troops` of `maxTroops`:
 * RUIN_TROOP_REWARD_PERCENT of their max troops, never past the cap.
 */
export function ruinTroopReward(troops: number, maxTroops: number): number {
  const burst = Math.floor((maxTroops * RUIN_TROOP_REWARD_PERCENT) / 100);
  return Math.max(0, Math.min(burst, Math.floor(maxTroops - troops)));
}

// ---------------------------------------------------------------------------
// City-states
// ---------------------------------------------------------------------------

/** Fewest city-states a map gets (when there is room for them). */
export const CITY_STATES_MIN_COUNT = 4;

/**
 * Most city-states a map gets, unless its map places more by hand (each
 * static custom_tribes entry is one, and they count toward the total).
 */
export const CITY_STATES_MAX_COUNT = 8;

/** One city-state per this many land tiles, clamped to the counts above. */
export const LAND_TILES_PER_CITY_STATE = 300_000;

/**
 * A randomly placed city-state's center is at least this many tiles
 * (euclidean) from every nation spawn cell and from every other city-state.
 */
export const CITY_STATE_MIN_DISTANCE = 40;

/** Radius in tiles (euclidean) of the disc of land a city-state starts with. */
export const CITY_STATE_RADIUS = 7;

/** At least this percent of a random city-state's disc must be usable land. */
export const CITY_STATE_MIN_LAND_PERCENT = 75;

/** Placement tries per city-state before the placer settles for fewer. */
export const CITY_STATE_PLACEMENT_TRIES = 2_000;

/** Level of the city at a city-state's center. */
export const CITY_STATE_CITY_LEVEL = 2;

/** Level its city drops to when a player captures it. */
export const CITY_STATE_CAPTURED_CITY_LEVEL = 1;

/**
 * A city-state is eliminated once it holds fewer tiles than this (a player
 * at 100, as upstream), so most of it has to be taken.
 */
export const CITY_STATE_ELIMINATION_TILES = 20;

/**
 * A city-state's garrison, and its troop cap, is this many times the troop
 * cap of a normal tribe holding as much land. Its own city adds nothing to it.
 */
export const CITY_STATE_GARRISON_MULTIPLIER = 3;

/** Gold the player who eliminates a city-state gets on top of conquest gold. */
export const CITY_STATE_CONQUEST_GOLD = 300_000;

/** Names for city-states that a map does not name (custom_tribes static). */
export const CITY_STATE_NAMES: readonly string[] = [
  "Aldmere",
  "Bastion",
  "Carrowmoor",
  "Dunhold",
  "Eastgate",
  "Fennwick",
  "Greyhaven",
  "Highmarch",
  "Ironford",
  "Kestrel Keep",
  "Lornwall",
  "Northwatch",
  "Oakhelm",
  "Ravensburg",
  "Stonebridge",
  "Westmarch",
];

/** How many random city-states a map with `landTiles` land tiles gets. */
export function cityStateCount(landTiles: number): number {
  return clampCount(
    Math.floor(landTiles / LAND_TILES_PER_CITY_STATE),
    CITY_STATES_MIN_COUNT,
    CITY_STATES_MAX_COUNT,
  );
}

/**
 * Troop cap of a city-state holding land worth `tribeTroopCap` to a normal
 * tribe (Config.maxTroops of a tribe without cities).
 */
export function cityStateTroopCap(tribeTroopCap: number): number {
  return tribeTroopCap * CITY_STATE_GARRISON_MULTIPLIER;
}

function clampCount(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
