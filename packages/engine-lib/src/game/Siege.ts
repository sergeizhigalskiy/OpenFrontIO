/**
 * Defense lines: defense post levels and siege camps.
 *
 * Shared by the engine (attack resolution, placement, cost) and the client
 * (the attack forecast, the coverage overlay, the build menu), so every
 * tunable number lives here.
 *
 * - A defense post upgrades to DEFENSE_POST_MAX_LEVEL. Each level reaches
 *   further (defensePostRange); its bonus to the defender is the same at
 *   every level.
 * - A siege camp is built on the owner's land near a hostile border. Once
 *   built, attacks by its owner and their friends treat enemy defense posts
 *   within SIEGE_CAMP_RANGE of it as giving only the SIEGE_CAMP_POST_* bonus.
 *   A tile still gets the full bonus when some post covering it has no
 *   friendly camp in range.
 */
import { GameMap, TileRef } from "@openfront/engine-api/game/GameMap";
import { UnitType } from "@openfront/engine-api/game/GameTypes";
import { UnitLike } from "@openfront/engine-api/game/ReadViews";
import { rangeQueryScans } from "./UnitGrid";

// ---------------------------------------------------------------------------
// Defense post levels
// ---------------------------------------------------------------------------

/** Highest level a defense post can be upgraded to. */
export const DEFENSE_POST_MAX_LEVEL = 3;

/** Tiles (euclidean) a defense post covers at levels 1, 2 and 3. */
const DEFENSE_POST_RANGES: readonly number[] = [30, 38, 45];

/** The range of a max-level post: no post reaches further. */
export const DEFENSE_POST_MAX_RANGE = 45;

/** Tiles a defense post of `level` covers. */
export function defensePostRange(level: number): number {
  const clamped = Math.min(DEFENSE_POST_MAX_LEVEL, Math.max(1, level | 0));
  return DEFENSE_POST_RANGES[clamped - 1];
}

// ---------------------------------------------------------------------------
// Siege camp
// ---------------------------------------------------------------------------

/** Enemy defense posts within this many tiles (euclidean) of a camp are reduced. */
export const SIEGE_CAMP_RANGE = 45;

/** Attacker-loss multiplier of a reduced defense post (a full one gives 5). */
export const SIEGE_CAMP_POST_DEFENSE_BONUS = 1.5;

/** Attack slowdown of a reduced defense post (a full one gives 3). */
export const SIEGE_CAMP_POST_SPEED_BONUS = 1.3;

/** A camp goes on the owner's land within this many tiles of a hostile player's land. */
export const SIEGE_CAMP_BORDER_RANGE = 10;

/** Build time in ticks (20 s). */
export const SIEGE_CAMP_CONSTRUCTION_TICKS = 200;

/** Price of the first camp; each one owned adds this much again. */
export const SIEGE_CAMP_BASE_COST = 300_000;

/** Camps never cost more than this. */
export const SIEGE_CAMP_MAX_COST = 1_200_000;

/** Price of a camp for a player who already owns `owned` of them. */
export function siegeCampCost(owned: number): number {
  return Math.min(
    SIEGE_CAMP_MAX_COST,
    (Math.max(0, owned) + 1) * SIEGE_CAMP_BASE_COST,
  );
}

// ---------------------------------------------------------------------------
// Coverage of an attacked tile
// ---------------------------------------------------------------------------

/** What the coverage checks need from the unit grid (UnitGrid.someUnitNearby). */
export interface DefenseUnitQuery {
  someUnitNearby<C>(
    tile: TileRef,
    searchRange: number,
    type: UnitType,
    ctx: C,
    visit: (unit: UnitLike, distSquared: number, ctx: C) => boolean,
  ): boolean;
}

/** No defense post of the defender covers the tile. */
export const POST_COVERAGE_NONE = 0;
/** A defense post covers the tile with its full bonus. */
export const POST_COVERAGE_FULL = 1;
/** Only defense posts reduced by the attacker side's siege camps cover it. */
export const POST_COVERAGE_REDUCED = 2;

export type PostCoverage =
  | typeof POST_COVERAGE_NONE
  | typeof POST_COVERAGE_FULL
  | typeof POST_COVERAGE_REDUCED;

interface CoverageScratch {
  map: GameMap | null;
  tile: TileRef;
  defenderSmallID: number;
  camps: readonly TileRef[];
  campCount: number;
  full: boolean;
  reduced: boolean;
  level: number;
}

const NO_CAMPS: readonly TileRef[] = [];

// One reused context: the per-tile check runs for every conquered tile, and
// both the simulation and the client are single-threaded.
const scratch: CoverageScratch = {
  map: null,
  tile: 0,
  defenderSmallID: 0,
  camps: NO_CAMPS,
  campCount: 0,
  full: false,
  reduced: false,
  level: 0,
};

/**
 * Whether `post`, `distSquared` from the tile, covers it: within its own
 * level's range, and where a grid query of that range would find it (the
 * engine always asked UnitGrid at the post's range, whose cells leave out a
 * post exactly that far along +x or +y; see rangeQueryScans). Querying at
 * the max range and filtering here keeps level 1 bit-identical to that.
 */
function postCovers(
  post: UnitLike,
  distSquared: number,
  s: CoverageScratch,
): boolean {
  if (post.owner().smallID() !== s.defenderSmallID) return false;
  const range = defensePostRange(post.level());
  return (
    distSquared <= range * range &&
    rangeQueryScans(s.map!, s.tile, range, post.tile())
  );
}

/** True when one of the first `count` camp tiles is within range of `post`. */
function campInRange(
  map: GameMap,
  post: TileRef,
  camps: readonly TileRef[],
  count: number,
): boolean {
  const rangeSquared = SIEGE_CAMP_RANGE * SIEGE_CAMP_RANGE;
  for (let i = 0; i < count; i++) {
    if (map.euclideanDistSquared(post, camps[i]) <= rangeSquared) return true;
  }
  return false;
}

function visitCoveringPost(
  unit: UnitLike,
  distSquared: number,
  s: CoverageScratch,
): boolean {
  if (!postCovers(unit, distSquared, s)) return false;
  if (
    s.campCount > 0 &&
    campInRange(s.map!, unit.tile(), s.camps, s.campCount)
  ) {
    s.reduced = true;
    return false; // an unreduced post elsewhere still gives the full bonus
  }
  s.full = true;
  return true;
}

/**
 * How the defender's defense posts cover `tile` for an attack whose side
 * (the attacker and its friends) has active siege camps on the first
 * `campCount` tiles of `camps`. Each post covers its own level's range; a
 * post within SIEGE_CAMP_RANGE of one of those camps is reduced. Allocates
 * nothing; with no camps it stops at the first covering post.
 */
export function defensePostCoverage(
  query: DefenseUnitQuery,
  map: GameMap,
  tile: TileRef,
  defenderSmallID: number,
  camps: readonly TileRef[],
  campCount: number,
): PostCoverage {
  scratch.map = map;
  scratch.tile = tile;
  scratch.defenderSmallID = defenderSmallID;
  scratch.camps = camps;
  scratch.campCount = campCount;
  scratch.full = false;
  scratch.reduced = false;
  query.someUnitNearby(
    tile,
    DEFENSE_POST_MAX_RANGE,
    UnitType.DefensePost,
    scratch,
    visitCoveringPost,
  );
  // Drop the references so the scratch doesn't hold a game alive.
  scratch.map = null;
  scratch.camps = NO_CAMPS;
  if (scratch.full) return POST_COVERAGE_FULL;
  return scratch.reduced ? POST_COVERAGE_REDUCED : POST_COVERAGE_NONE;
}

function visitPostLevel(
  unit: UnitLike,
  distSquared: number,
  s: CoverageScratch,
): boolean {
  if (postCovers(unit, distSquared, s) && unit.level() > s.level) {
    s.level = unit.level();
  }
  return false;
}

/** The highest level of the defender's defense posts covering `tile`, 0 if none. */
export function coveringDefensePostLevel(
  query: DefenseUnitQuery,
  map: GameMap,
  tile: TileRef,
  defenderSmallID: number,
): number {
  scratch.map = map;
  scratch.tile = tile;
  scratch.defenderSmallID = defenderSmallID;
  scratch.level = 0;
  query.someUnitNearby(
    tile,
    DEFENSE_POST_MAX_RANGE,
    UnitType.DefensePost,
    scratch,
    visitPostLevel,
  );
  scratch.map = null;
  return scratch.level;
}
