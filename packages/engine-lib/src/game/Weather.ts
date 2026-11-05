import { GameMap } from "@openfront/engine-api/game/GameMap";
import {
  WeatherCell,
  WeatherKind,
} from "@openfront/engine-api/game/GameUpdates";
import { PseudoRandom } from "../PseudoRandom";

/**
 * Weather systems: circles that drift over the map on seeded straight paths.
 * WeatherExecution keeps WEATHER_MIN_CELLS to WEATHER_MAX_CELLS of them alive.
 * Each is a forecast (a dashed outline on the client) for
 * WEATHER_WARNING_TICKS, then takes effect for 2 to 4 minutes:
 *
 * - Mud front (spawns over land): enemy land under it costs
 *   MUD_TILE_COST_MULTIPLIER times the attack's tick budget per tile. Losses
 *   are unchanged.
 * - Sea storm (spawns over ocean): ships on water inside move at
 *   1 / STORM_SPEED_DIVISOR speed, and transport ships and sea convoys lose
 *   STORM_TROOP_LOSS_PERCENT_PER_TICK of their troops per tick, at most
 *   STORM_TROOP_LOSS_MAX_PERCENT over one storm.
 * - Fog (anywhere): the client hides enemy troop counts inside it. No engine
 *   effect.
 *
 * Positions are a pure function of the cell and the tick (see WeatherCell),
 * so the engine and the client agree without per-tick updates. Only + - * /
 * and Math.sqrt touch floats, all exact in IEEE 754, so every client gets the
 * same bits.
 */

export const WEATHER_MIN_CELLS = 2;
export const WEATHER_MAX_CELLS = 4;
export const WEATHER_MIN_RADIUS = 40;
export const WEATHER_MAX_RADIUS = 80;
/** About one tile every 10 ticks. */
export const WEATHER_DRIFT_PER_TICK = 0.1;
/** A cell is announced this long before it takes effect: 30 seconds. */
export const WEATHER_WARNING_TICKS = 30 * 10;
/** How long a cell is in effect: 2 to 4 minutes. */
export const WEATHER_MIN_ACTIVE_TICKS = 2 * 60 * 10;
export const WEATHER_MAX_ACTIVE_TICKS = 4 * 60 * 10;
/** Seeded gap before an extra cell (above the minimum): 1 to 2 minutes. */
export const WEATHER_SPAWN_GAP_MIN_TICKS = 60 * 10;
export const WEATHER_SPAWN_GAP_MAX_TICKS = 2 * 60 * 10;
/** Tries to find a tile a cell's kind may spawn over. */
const WEATHER_SPAWN_ATTEMPTS = 50;

/** Enemy land under a mud front is this many times slower to take. */
export const MUD_TILE_COST_MULTIPLIER = 1.5;
/** Ships in a sea storm move at 1 / this speed. */
export const STORM_SPEED_DIVISOR = 2;
/** Troops a transport or sea convoy loses each tick in a storm, in percent. */
export const STORM_TROOP_LOSS_PERCENT_PER_TICK = 1;
/** The most it loses over one storm, in percent of its troops on entering. */
export const STORM_TROOP_LOSS_MAX_PERCENT = 25;

const KINDS: readonly WeatherKind[] = [
  WeatherKind.Mud,
  WeatherKind.Storm,
  WeatherKind.Fog,
];

/** The cell's center at `tick`, in tiles. */
export function cellCenterAt(
  cell: WeatherCell,
  tick: number,
): { x: number; y: number } {
  const dt = tick - cell.announceTick;
  return { x: cell.x + cell.dx * dt, y: cell.y + cell.dy * dt };
}

/** Announced but not in effect yet. */
export function isCellForecast(cell: WeatherCell, tick: number): boolean {
  return tick >= cell.announceTick && tick < cell.activeTick;
}

export function isCellActive(cell: WeatherCell, tick: number): boolean {
  return tick >= cell.activeTick && tick < cell.endTick;
}

/** Whether tile (x, y) lies inside the cell's circle at `tick`. */
export function cellCovers(
  cell: WeatherCell,
  tick: number,
  x: number,
  y: number,
): boolean {
  const dt = tick - cell.announceTick;
  const ox = x - (cell.x + cell.dx * dt);
  const oy = y - (cell.y + cell.dy * dt);
  return ox * ox + oy * oy <= cell.radius * cell.radius;
}

/** The first cell of `kind` in effect over (x, y) at `tick`, or null. */
export function activeCellAt(
  cells: readonly WeatherCell[],
  tick: number,
  x: number,
  y: number,
  kind: WeatherKind,
): WeatherCell | null {
  for (const cell of cells) {
    if (
      cell.kind === kind &&
      isCellActive(cell, tick) &&
      cellCovers(cell, tick, x, y)
    ) {
      return cell;
    }
  }
  return null;
}

/** The weather in effect over (x, y), first cell first, or null. */
export function weatherKindAt(
  cells: readonly WeatherCell[],
  tick: number,
  x: number,
  y: number,
): WeatherKind | null {
  for (const cell of cells) {
    if (isCellActive(cell, tick) && cellCovers(cell, tick, x, y)) {
      return cell.kind;
    }
  }
  return null;
}

/** Tick cost multiplier for taking the enemy tile at (x, y). */
export function mudTileCostMultiplier(
  cells: readonly WeatherCell[],
  tick: number,
  x: number,
  y: number,
): number {
  return activeCellAt(cells, tick, x, y, WeatherKind.Mud) !== null
    ? MUD_TILE_COST_MULTIPLIER
    : 1;
}

/**
 * Troops a transport or sea convoy loses this tick in a storm it entered
 * with `entryTroops`, having lost `lostSoFar` to it already.
 */
export function stormTroopLoss(entryTroops: number, lostSoFar: number): number {
  const perTick = (entryTroops * STORM_TROOP_LOSS_PERCENT_PER_TICK) / 100;
  const cap = (entryTroops * STORM_TROOP_LOSS_MAX_PERCENT) / 100;
  return Math.max(0, Math.min(perTick, cap - lostSoFar));
}

/**
 * Fog: whether the client hides a troop count shown at (x, y). Never for
 * anything the viewer owns or is allied with (`seesThrough`).
 */
export function fogHidesTroops(
  cells: readonly WeatherCell[],
  tick: number,
  x: number,
  y: number,
  seesThrough: boolean,
): boolean {
  return (
    !seesThrough && activeCellAt(cells, tick, x, y, WeatherKind.Fog) !== null
  );
}

/**
 * Whether the segment (x0, y0)-(x1, y1) passes through the cell's circle at
 * `tick`.
 */
export function segmentCrossesCell(
  cell: WeatherCell,
  tick: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  const c = cellCenterAt(cell, tick);
  const abx = x1 - x0;
  const aby = y1 - y0;
  const len2 = abx * abx + aby * aby;
  let t = len2 === 0 ? 0 : ((c.x - x0) * abx + (c.y - y0) * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  const px = x0 + abx * t - c.x;
  const py = y0 + aby * t - c.y;
  return px * px + py * py <= cell.radius * cell.radius;
}

/** Whether a cell of `kind` may be centered over `tile`. */
function canSpawnOver(map: GameMap, tile: number, kind: WeatherKind): boolean {
  switch (kind) {
    case WeatherKind.Mud:
      return map.isLand(tile) && !map.isImpassable(tile);
    case WeatherKind.Storm:
      return map.isOcean(tile);
    case WeatherKind.Fog:
      return !map.isImpassable(tile);
  }
}

/**
 * A new cell announced at `tick`, drawn from `random`: a kind, a center that
 * kind may spawn over (mud over land, storms over ocean, fog anywhere; a kind
 * with no such tile found falls back to fog), a radius, a lifetime, and a
 * drift toward a random point on the map.
 */
export function planWeatherCell(
  random: PseudoRandom,
  map: GameMap,
  id: number,
  tick: number,
): WeatherCell {
  const w = map.width();
  const h = map.height();
  let kind = KINDS[random.nextInt(0, KINDS.length)];
  const radius = random.nextInt(WEATHER_MIN_RADIUS, WEATHER_MAX_RADIUS + 1);
  const active = random.nextInt(
    WEATHER_MIN_ACTIVE_TICKS,
    WEATHER_MAX_ACTIVE_TICKS + 1,
  );

  let x = 0;
  let y = 0;
  let found = false;
  for (let i = 0; i < WEATHER_SPAWN_ATTEMPTS && !found; i++) {
    x = random.nextInt(0, w);
    y = random.nextInt(0, h);
    found = canSpawnOver(map, map.ref(x, y), kind);
  }
  if (!found) kind = WeatherKind.Fog;

  // Drift toward a random point, so cells cross the map instead of hugging
  // an edge. A point on top of the center drifts east.
  let vx = random.nextInt(0, w) - x;
  let vy = random.nextInt(0, h) - y;
  const len = Math.sqrt(vx * vx + vy * vy);
  if (len < 1) {
    vx = 1;
    vy = 0;
  } else {
    vx /= len;
    vy /= len;
  }

  const activeTick = tick + WEATHER_WARNING_TICKS;
  return {
    id,
    kind,
    x,
    y,
    dx: vx * WEATHER_DRIFT_PER_TICK,
    dy: vy * WEATHER_DRIFT_PER_TICK,
    radius,
    announceTick: tick,
    activeTick,
    endTick: activeTick + active,
  };
}
