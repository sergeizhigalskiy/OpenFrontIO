/**
 * Defense post levels and the coverage of an attacked tile.
 *
 * Shared by the engine (attack resolution) and the client (the attack
 * forecast, the coverage overlay, the build menu), so every tunable number
 * lives here.
 *
 * A defense post upgrades to DEFENSE_POST_MAX_LEVEL. Each level reaches
 * further (defensePostRange); its bonus to the defender is the same at every
 * level.
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

interface CoverageScratch {
  map: GameMap | null;
  tile: TileRef;
  defenderSmallID: number;
  level: number;
}

// One reused context: the per-tile check runs for every conquered tile, and
// both the simulation and the client are single-threaded.
const scratch: CoverageScratch = {
  map: null,
  tile: 0,
  defenderSmallID: 0,
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

/**
 * Whether one of the defender's defense posts covers `tile`, each post
 * within its own level's range. Allocates nothing and stops at the first
 * covering post.
 */
export function defensePostCovers(
  query: DefenseUnitQuery,
  map: GameMap,
  tile: TileRef,
  defenderSmallID: number,
): boolean {
  scratch.map = map;
  scratch.tile = tile;
  scratch.defenderSmallID = defenderSmallID;
  const covered = query.someUnitNearby(
    tile,
    DEFENSE_POST_MAX_RANGE,
    UnitType.DefensePost,
    scratch,
    postCovers,
  );
  // Drop the reference so the scratch doesn't hold a game alive.
  scratch.map = null;
  return covered;
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
