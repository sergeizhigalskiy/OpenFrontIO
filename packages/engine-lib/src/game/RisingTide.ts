/**
 * Rising tide (game mode, off by default): a battle-royale squeeze. Every few
 * minutes a flood wave turns the lowest coastal land into water, until the
 * fight is on the highlands.
 *
 * Shared by the engine (RisingTideExecution) and the client (HUD countdown),
 * so every tunable number lives here. All math is integer, so the engine
 * stays deterministic.
 */
import { GameMap, TileRef } from "@openfront/engine-api/game/GameMap";

const TICKS_PER_SECOND = 10;
const TICKS_PER_MINUTE = 60 * TICKS_PER_SECOND;

/** The first wave floods this long after the spawn phase. */
export const RISING_TIDE_FIRST_WAVE_TICKS = 8 * TICKS_PER_MINUTE;

/** Time between waves. */
export const RISING_TIDE_WAVE_INTERVAL_TICKS = 3 * TICKS_PER_MINUTE;

/** The tiles a wave will flood are shown this long before it floods. */
export const RISING_TIDE_WARNING_TICKS = 30 * TICKS_PER_SECOND;

/** A wave floods up to this percent of the map's original land tiles. */
export const RISING_TIDE_WAVE_PERCENT = 4;

/**
 * Hard cap on the tiles one wave floods. A wave converts every tile in the
 * same tick and rebuilds the water graph right away (see WaterManager), so
 * this keeps that tick cheap on the largest maps: measured on the 4108x1948
 * test map, 40k tiles take ~240 ms to convert and ~35 ms to rebuild the
 * graph. It binds above 1.25M land tiles (4% of the median map).
 */
export const RISING_TIDE_MAX_TILES_PER_WAVE = 50_000;

/** The tide stops once the land left is this percent of the original. */
export const RISING_TIDE_STOP_PERCENT = 40;

/**
 * Troops a player loses to a flood: the `onFlooded` of its `troops` that
 * stood on the flooded tiles fall back to its remaining land, and only what
 * would leave it above `maxTroops` (its cap on the land left) is lost.
 */
export function risingTideTroopsLost(
  troops: number,
  onFlooded: number,
  maxTroops: number,
): number {
  return Math.max(0, Math.min(onFlooded, troops - maxTroops));
}

/**
 * Tiles the next wave may flood: RISING_TIDE_WAVE_PERCENT of the original land
 * (at least one tile), capped by RISING_TIDE_MAX_TILES_PER_WAVE and by what is
 * left above the RISING_TIDE_STOP_PERCENT floor. 0 means the tide is done.
 */
export function risingTideWaveBudget(
  originalLand: number,
  currentLand: number,
): number {
  const floor = Math.ceil((originalLand * RISING_TIDE_STOP_PERCENT) / 100);
  const room = currentLand - floor;
  if (room <= 0) return 0;
  const perWave = Math.max(
    1,
    Math.floor((originalLand * RISING_TIDE_WAVE_PERCENT) / 100),
  );
  return Math.min(room, perWave, RISING_TIDE_MAX_TILES_PER_WAVE);
}

/**
 * The land the next wave floods, in flood order, at most `budget` tiles.
 *
 * The water rises from the ocean: the candidates are passable land tiles next
 * to the ocean, and the lowest one (by terrain magnitude, ties by tile index)
 * floods first. A flooded tile counts as ocean, so the land behind it becomes
 * a candidate in the same wave. That is a priority flood: low coastal plains
 * go first and the water climbs into the valleys before the hills. Pure
 * integer work over the terrain, so every client floods the same tiles.
 */
export function risingTideWaveTiles(map: GameMap, budget: number): TileRef[] {
  if (budget <= 0) return [];
  const width = map.width();
  const numTiles = width * map.height();
  const queued = new Uint8Array(numTiles);
  const heap = new TileHeap(numTiles);
  for (let t = 0; t < numTiles; t++) {
    if (map.isImpassable(t) || !map.isOceanShore(t)) continue;
    queued[t] = 1;
    heap.push(map.magnitude(t), t);
  }
  const out: TileRef[] = [];
  const nbuf: TileRef[] = [0, 0, 0, 0];
  while (out.length < budget && heap.size > 0) {
    const tile = heap.pop();
    out.push(tile);
    const n = map.neighbors4(tile, nbuf);
    for (let i = 0; i < n; i++) {
      const nb = nbuf[i];
      if (queued[nb] === 1 || !map.isLand(nb) || map.isImpassable(nb)) {
        continue;
      }
      queued[nb] = 1;
      heap.push(map.magnitude(nb), nb);
    }
  }
  return out;
}

/**
 * Land a wave would leave as a scrap smaller than this many tiles goes under
 * with it (risingTideIslandTiles): 2 per 10,000 tiles of the original land
 * (about 130 on the World map), at least 8 and at most 400.
 */
export const RISING_TIDE_MIN_ISLAND_FLOOR = 8;
export const RISING_TIDE_MIN_ISLAND_PER_10K = 2;
export const RISING_TIDE_MIN_ISLAND_MAX = 400;

/** The smallest piece of land a wave may leave behind, in tiles. */
export function risingTideMinIsland(originalLand: number): number {
  return Math.min(
    RISING_TIDE_MIN_ISLAND_MAX,
    Math.max(
      RISING_TIDE_MIN_ISLAND_FLOOR,
      Math.floor((originalLand * RISING_TIDE_MIN_ISLAND_PER_10K) / 10000),
    ),
  );
}

/**
 * The land that would be left as tiny islands once `wave` floods: every
 * piece of land (4-connected, as units move) touching the wave that has
 * fewer than `minTiles` tiles with the wave counted as water. A wave floods
 * these too, so the tide never leaves dots of land behind where it climbed
 * around a slightly higher tile. Land pieces the wave doesn't touch are left
 * alone, and impassable tiles never flood (they still count toward a
 * piece's size). Returns passable tiles in a fixed order (wave order, then
 * each piece breadth-first): pure integer work, so deterministic.
 */
export function risingTideIslandTiles(
  map: GameMap,
  wave: readonly TileRef[],
  minTiles: number,
): TileRef[] {
  if (wave.length === 0 || minTiles <= 1) return [];
  const numTiles = map.width() * map.height();
  // 1: floods in the wave, 2: in the piece being measured, 3: in a piece big
  // enough to stay, 4: in a tiny piece that floods.
  const mark = new Uint8Array(numTiles);
  for (const t of wave) mark[t] = 1;
  const out: TileRef[] = [];
  const piece: TileRef[] = [];
  const nbuf: TileRef[] = [0, 0, 0, 0];
  const qbuf: TileRef[] = [0, 0, 0, 0];
  for (const t of wave) {
    const n = map.neighbors4(t, nbuf);
    for (let i = 0; i < n; i++) {
      const seed = nbuf[i];
      if (mark[seed] !== 0 || !map.isLand(seed)) continue;
      // Measure the piece around seed, stopping once it is big enough.
      piece.length = 0;
      piece.push(seed);
      mark[seed] = 2;
      let big = false;
      for (let head = 0; head < piece.length && !big; head++) {
        const m = map.neighbors4(piece[head], qbuf);
        for (let j = 0; j < m; j++) {
          const nb = qbuf[j];
          if (!map.isLand(nb)) continue;
          const k = mark[nb];
          if (k === 3) {
            big = true;
            break;
          }
          if (k !== 0) continue;
          mark[nb] = 2;
          piece.push(nb);
          if (piece.length >= minTiles) {
            big = true;
            break;
          }
        }
      }
      for (const p of piece) {
        if (big) {
          mark[p] = 3;
        } else {
          mark[p] = 4;
          if (!map.isImpassable(p)) out.push(p);
        }
      }
    }
  }
  return out;
}

/**
 * The tiles the next wave floods: the priority flood (risingTideWaveTiles)
 * of `budget` tiles plus the tiny islands it would cut off
 * (risingTideIslandTiles). Those come on top of the budget; the next wave's
 * budget (risingTideScheduledBudget) takes them back out, so the tide keeps
 * its schedule.
 */
export function risingTidePlanWave(
  map: GameMap,
  budget: number,
  minIsland: number,
): TileRef[] {
  const wave = risingTideWaveTiles(map, budget);
  return wave.concat(risingTideIslandTiles(map, wave, minIsland));
}

/**
 * The flood budget for wave number `wavesDone` (0 for the first) that keeps
 * the tide on its schedule of RISING_TIDE_WAVE_PERCENT of the original land
 * per wave, even though waves also flood the islands they cut off: a wave
 * floods what brings the land back to where the schedule has it after this
 * wave, at least half a normal wave and at most a whole one, within the same
 * cap and floor as risingTideWaveBudget. 0 means the tide is done.
 */
export function risingTideScheduledBudget(
  originalLand: number,
  currentLand: number,
  wavesDone: number,
): number {
  const normal = risingTideWaveBudget(originalLand, currentLand);
  if (normal <= 0) return 0;
  // A normal wave, capped as in risingTideWaveBudget.
  const perWave = Math.min(
    RISING_TIDE_MAX_TILES_PER_WAVE,
    Math.max(1, Math.floor((originalLand * RISING_TIDE_WAVE_PERCENT) / 100)),
  );
  const onSchedule = originalLand - (wavesDone + 1) * perWave;
  const behind = currentLand - onSchedule;
  const share = Math.min(perWave, Math.max(Math.ceil(perWave / 2), behind));
  return Math.min(normal, share);
}

/** Binary min-heap of tiles keyed by (magnitude, tile index). */
class TileHeap {
  private keys: number[] = [];
  constructor(private readonly numTiles: number) {}

  get size(): number {
    return this.keys.length;
  }

  push(magnitude: number, tile: TileRef): void {
    const keys = this.keys;
    // Unique per tile and exact in a float64: 31 * numTiles < 2^53.
    const key = magnitude * this.numTiles + tile;
    let i = keys.length;
    keys.push(key);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      keys[i] = keys[parent];
      i = parent;
    }
    keys[i] = key;
  }

  pop(): TileRef {
    const keys = this.keys;
    const top = keys[0];
    const last = keys.pop()!;
    if (keys.length > 0) {
      let i = 0;
      const n = keys.length;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && keys[r] < keys[l] ? r : l;
        if (keys[c] >= last) break;
        keys[i] = keys[c];
        i = c;
      }
      keys[i] = last;
    }
    return top % this.numTiles;
  }
}
