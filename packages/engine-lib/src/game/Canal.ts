import { GameMap, TileRef } from "@openfront/engine-api/game/GameMap";
import { Structures, UnitType } from "@openfront/engine-api/game/GameTypes";
import { PlayerLike } from "@openfront/engine-api/game/ReadViews";

/**
 * Canals: dig across a narrow land neck to join two waters (UnitType.Canal,
 * run by CanalExecution).
 *
 * The rules, kept small on purpose:
 * - The player clicks a land tile. The canal is the shortest roughly straight
 *   path through it, out of CANAL_DIRECTIONS, that has water at both ends
 *   after at most CANAL_MAX_LENGTH steps of land. It is CANAL_WIDTH tiles
 *   wide (two parallel rows) so ships can pass, diagonals included.
 * - The two ends must be different waters, or parts of one water that are
 *   not joined by a water route of CANAL_MIN_WATER_DETOUR tiles or less.
 * - Every land tile of the path must be the builder's and hold none of their
 *   structures.
 * - It costs CANAL_COST_PER_TILE per step of length (so a 12-step canal
 *   costs 12 x 150k = 1.8M; the second row is free) and takes
 *   CANAL_CONSTRUCTION_TICKS to dig. Losing any path tile before then
 *   cancels it with no refund. When done, the path's tiles become water.
 *
 * Shared by the engine (validation, cost, the dig) and the client (the build
 * menu's reason when it can't be built, and drawing the dig).
 */

/** Most steps of land a canal may cross. */
export const CANAL_MAX_LENGTH = 12;
/** Rows of water a canal digs side by side. */
export const CANAL_WIDTH = 2;
/** Gold per step of canal length. */
export const CANAL_COST_PER_TILE = 150_000;
/** 60 seconds at 10 ticks per second. */
export const CANAL_CONSTRUCTION_TICKS = 600;
/**
 * The two ends of a canal are "separated" unless a water route of at most
 * this many tiles already joins them (then the canal would save nothing).
 */
export const CANAL_MIN_WATER_DETOUR = 50;

/**
 * Directions a canal may run, as integer steps over half a circle (the
 * opposite directions are the same lines), about every 11 degrees. Tried in
 * this order, so ties in length go to the earlier one.
 */
export const CANAL_DIRECTIONS: readonly (readonly [number, number])[] = [
  [1, 0],
  [5, 1],
  [5, 2],
  [3, 2],
  [1, 1],
  [2, 3],
  [2, 5],
  [1, 5],
  [0, 1],
  [-1, 5],
  [-2, 5],
  [-2, 3],
  [-1, 1],
  [-3, 2],
  [-5, 2],
  [-5, 1],
];

export interface CanalPath {
  /** The land tiles to dig, in path order (both rows). */
  tiles: TileRef[];
  /** Steps of land along the path; the price is per step. */
  length: number;
  /**
   * First and last land tile of the path's first row: the canal unit's tile
   * and targetTile, which the client draws the dig between.
   */
  start: TileRef;
  end: TileRef;
  /** One water tile at each end. */
  waterA: TileRef;
  waterB: TileRef;
}

/** Why a canal can't be built on a tile; each has a "canal.<reason>" text. */
export type CanalBlockReason =
  | "not_land"
  | "no_neck"
  | "already_connected"
  | "not_owned"
  | "has_structure"
  | "already_digging";

export type CanalPathResult =
  | { ok: true; path: CanalPath }
  | { ok: false; reason: CanalBlockReason };

/** Integer division by `m`, rounded half away from zero (symmetric in sign). */
function roundDiv(n: number, m: number): number {
  const q = Math.floor((Math.abs(n) * 2 + m) / (2 * m));
  return n < 0 ? -q : q;
}

interface Ends {
  /** Index of the first water on the negative / positive side. */
  lo: number;
  hi: number;
}

/**
 * Walks one row of the line through (x0, y0) both ways until water.
 * Null when the row starts on water, leaves the map, meets impassable
 * terrain, or runs longer than CANAL_MAX_LENGTH.
 */
function rowEnds(
  map: GameMap,
  point: (k: number) => [number, number],
): Ends | null {
  const at = (k: number): TileRef | null => {
    const [x, y] = point(k);
    if (!map.isValidCoord(x, y)) return null;
    const t = map.ref(x, y);
    return map.isImpassable(t) ? null : t;
  };
  const center = at(0);
  if (center === null || !map.isLand(center)) return null;
  const ends: number[] = [];
  for (const sign of [-1, 1]) {
    let found = false;
    for (let k = 1; k <= CANAL_MAX_LENGTH; k++) {
      const t = at(sign * k);
      if (t === null) return null;
      if (!map.isLand(t)) {
        ends.push(sign * k);
        found = true;
        break;
      }
    }
    if (!found) return null;
  }
  return { lo: ends[0], hi: ends[1] };
}

/** True when water joins `a` to `b` within `maxSteps` steps (4-neighbors). */
function waterJoinedWithin(
  map: GameMap,
  a: TileRef,
  b: TileRef,
  maxSteps: number,
): boolean {
  if (a === b) return true;
  const seen = new Set<TileRef>([a]);
  let frontier: TileRef[] = [a];
  const nbuf: TileRef[] = [];
  for (let step = 0; step < maxSteps && frontier.length > 0; step++) {
    const next: TileRef[] = [];
    for (const t of frontier) {
      const n = map.neighbors4(t, nbuf);
      for (let i = 0; i < n; i++) {
        const nb = nbuf[i];
        if (seen.has(nb) || map.isLand(nb)) continue;
        if (nb === b) return true;
        seen.add(nb);
        next.push(nb);
      }
    }
    frontier = next;
  }
  return false;
}

interface Candidate {
  path: CanalPath;
  order: number;
}

/**
 * The canal through `tile`, from terrain alone: the shortest straight path
 * of land with water at both ends, among CANAL_DIRECTIONS, whose ends are
 * separated waters. Owners and structures are checked by canalBlockReason.
 */
export function findCanalPath(map: GameMap, tile: TileRef): CanalPathResult {
  if (!map.isValidRef(tile) || !map.isLand(tile) || map.isImpassable(tile)) {
    return { ok: false, reason: "not_land" };
  }
  const x0 = map.x(tile);
  const y0 = map.y(tile);
  const candidates: Candidate[] = [];

  for (let d = 0; d < CANAL_DIRECTIONS.length; d++) {
    const [dx, dy] = CANAL_DIRECTIONS[d];
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    // The second row sits beside the first across the line's minor axis,
    // which keeps a diagonal canal 4-connected.
    const [ox, oy] = Math.abs(dx) >= Math.abs(dy) ? [0, 1] : [1, 0];
    const row = (r: number) => (k: number) =>
      [
        x0 + roundDiv(k * dx, m) + r * ox,
        y0 + roundDiv(k * dy, m) + r * oy,
      ] as [number, number];
    const rows = [row(0), row(1)];
    const ends: Ends[] = [];
    for (const r of rows) {
      const e = rowEnds(map, r);
      if (e === null) break;
      ends.push(e);
    }
    if (ends.length !== CANAL_WIDTH) continue;

    const lo = Math.min(ends[0].lo, ends[1].lo);
    const hi = Math.max(ends[0].hi, ends[1].hi);
    // Steps between the waters: indices lo+1 .. hi-1.
    const length = hi - lo - 1;
    if (length > CANAL_MAX_LENGTH) continue;

    const tiles: TileRef[] = [];
    for (let k = lo + 1; k < hi; k++) {
      for (let r = 0; r < CANAL_WIDTH; r++) {
        if (k <= ends[r].lo || k >= ends[r].hi) continue;
        const [x, y] = rows[r](k);
        tiles.push(map.ref(x, y));
      }
    }
    const ref = (r: number, k: number) => {
      const [x, y] = rows[r](k);
      return map.ref(x, y);
    };
    candidates.push({
      order: d,
      path: {
        tiles,
        length,
        start: ref(0, ends[0].lo + 1),
        end: ref(0, ends[0].hi - 1),
        waterA: ref(0, ends[0].lo),
        waterB: ref(0, ends[0].hi),
      },
    });
  }

  if (candidates.length === 0) return { ok: false, reason: "no_neck" };
  candidates.sort((a, b) => a.path.length - b.path.length || a.order - b.order);
  for (const c of candidates) {
    if (
      !waterJoinedWithin(
        map,
        c.path.waterA,
        c.path.waterB,
        CANAL_MIN_WATER_DETOUR,
      )
    ) {
      return { ok: true, path: c.path };
    }
  }
  return { ok: false, reason: "already_connected" };
}

/**
 * Why `player` can't dig `path`, or null when they can: every tile must be
 * theirs and hold none of their structures, and they must not be digging it
 * already (a second click would only pay twice for the same water).
 */
export function canalBlockReason(
  map: GameMap,
  player: PlayerLike,
  path: CanalPath,
): CanalBlockReason | null {
  const smallID = player.smallID();
  for (const t of path.tiles) {
    if (map.ownerID(t) !== smallID) return "not_owned";
  }
  const onPath = new Set(path.tiles);
  for (const type of Structures.types) {
    for (const u of player.units(type)) {
      if (u.isActive() && onPath.has(u.tile())) return "has_structure";
    }
  }
  for (const dig of player.units(UnitType.Canal)) {
    if (dig.isActive() && onPath.has(dig.tile())) return "already_digging";
  }
  return null;
}

/** The path and whether `player` may dig it, for the build menu. */
export function canalPlanFor(
  map: GameMap,
  player: PlayerLike,
  tile: TileRef,
): CanalPathResult {
  const found = findCanalPath(map, tile);
  if (!found.ok) return found;
  const reason = canalBlockReason(map, player, found.path);
  return reason === null ? found : { ok: false, reason };
}

/** Gold for a canal of `length` steps, before infinite-gold cheats. */
export function canalCost(length: number): number {
  return CANAL_COST_PER_TILE * length;
}
