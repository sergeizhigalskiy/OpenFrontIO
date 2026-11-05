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
