/**
 * Climate data — per-tile fields that let the terrain shader pick biomes and
 * draw a soft coastline. Pure functions, no GL; ClimateField.ts uploads them.
 *
 * One RGBA8 texel per tile, sampled LINEAR:
 *   R  signed coast distance: + inside passable land, - over water, 0 on
 *      impassable tiles (neither), COAST_SDF_UNITS per tile around 128. Each
 *      tile stores the distance from its centre to the nearest tile of the
 *      other kind, less half a tile, so a bilinear sample crosses 0 halfway
 *      between a land and a water centre; a light blur then irons out the
 *      stair steps, while every tile keeps its own side of the line (a lone
 *      island tile stays a small island). The zero line is the coast the
 *      terrain, territory and border shaders all draw.
 *   G  moisture, 0 (dry) - 255 (wet): near water, rivers and forests is wet,
 *      deep inland is dry, broken up by broad noise. Dry lowland reads as
 *      steppe and desert, wet as lush grass.
 *   B  cold, 0-255: rises toward the top of the map inside the northern snow
 *      band (engine-lib Seasons: SNOW_NORTH_PERCENT), so the far north reads
 *      as tundra, and it is where winter snow falls.
 *   A  broad albedo variation (noise over ~100 tiles), so wide plains and
 *      deserts aren't one flat colour.
 */

import { SNOW_NORTH_PERCENT } from "@openfront/engine-lib/game/Seasons";
import { gradientNoise } from "./ReliefHeights";
import { squaredDistanceTransform } from "./SurfaceData";

const LAND_BIT = 0x80;
const MAGNITUDE_MASK = 0x1f;
const IMPASSABLE_MAGNITUDE = 31;

/** Coast distance (R) units per tile, around 128. */
export const COAST_SDF_UNITS = 32;
/** The coast distance saturates this far out, tiles. */
export const COAST_SDF_RANGE = 127 / COAST_SDF_UNITS;
/** Moisture falls off over this many tiles from water. */
export const MOISTURE_RANGE = 70;
/** How far the coast fields are patched around a flooded tile. */
export const COAST_PATCH_RADIUS = Math.ceil(COAST_SDF_RANGE) + 2;
/** The blur never pushes a tile's centre closer than this to the coast. */
const COAST_KEEP_SIDE = 0.18;

const WATER = 0;
const LAND = 1;
const WALL = 2;

function kindOf(b: number): number {
  if ((b & LAND_BIT) === 0) return WATER;
  return (b & MAGNITUDE_MASK) === IMPASSABLE_MAGNITUDE ? WALL : LAND;
}

export function encodeCoastSdf(signedTiles: number): number {
  return Math.min(
    255,
    Math.max(0, Math.round(128 + signedTiles * COAST_SDF_UNITS)),
  );
}

/** Inverse of encodeCoastSdf (what the shader does after filtering). */
export function decodeCoastSdf(byte: number): number {
  return (byte - 128) / COAST_SDF_UNITS;
}

/** Signed coast distance of one tile from its squared distances. */
function coastSdf(kind: number, sqToLand: number, sqToWater: number): number {
  if (kind === WALL) return 0;
  if (kind === LAND) {
    return sqToWater === Infinity
      ? COAST_SDF_RANGE
      : Math.sqrt(sqToWater) - 0.5;
  }
  return sqToLand === Infinity
    ? -COAST_SDF_RANGE
    : -(Math.sqrt(sqToLand) - 0.5);
}

/**
 * [1,2,1]² blur of the raw coast distances `raw` (window ww×wh) at window
 * cell (x, y), kept on the tile's own side of the coast.
 */
function blurredSdf(
  raw: Float32Array,
  kind: (wx: number, wy: number) => number,
  ww: number,
  wh: number,
  x: number,
  y: number,
): number {
  const k = kind(x, y);
  if (k === WALL) return 0;
  let sum = 0;
  let wsum = 0;
  for (let dy = -1; dy <= 1; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= wh) continue;
    for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx;
      if (xx < 0 || xx >= ww) continue;
      const w = (dx === 0 ? 2 : 1) * (dy === 0 ? 2 : 1);
      sum += w * raw[yy * ww + xx];
      wsum += w;
    }
  }
  const v = sum / wsum;
  return k === LAND
    ? Math.max(v, COAST_KEEP_SIDE)
    : Math.min(v, -COAST_KEEP_SIDE);
}

/** Cold (0-1) at tile row y: 0 south of the snow band, 1 near the top. */
export function coldAt(y: number, h: number): number {
  const band = (h * SNOW_NORTH_PERCENT) / 100;
  if (band <= 0) return 0;
  const t = Math.min(1, Math.max(0, (band - (y + 0.5)) / (band * 0.68)));
  return t * t * (3 - 2 * t);
}

/**
 * Build the climate field. `features` (one TerrainFeature per tile: 1 forest,
 * 2 river, 3 ford) is optional; rivers count as water and forests as wet
 * ground for moisture.
 */
export function buildClimateField(
  terrain: Uint8Array,
  w: number,
  h: number,
  features: Uint8Array | null = null,
): Uint8Array {
  const n = w * h;
  const out = new Uint8Array(n * 4);
  const kind = new Uint8Array(n);
  for (let i = 0; i < n; i++) kind[i] = kindOf(terrain[i]);

  // R: signed coast distance.
  const mask = new Uint8Array(n);
  const toLand = new Float32Array(n);
  const toWater = new Float32Array(n);
  for (let i = 0; i < n; i++) mask[i] = kind[i] === LAND ? 1 : 0;
  squaredDistanceTransform(mask, w, h, toLand);
  for (let i = 0; i < n; i++) mask[i] = kind[i] === WATER ? 1 : 0;
  squaredDistanceTransform(mask, w, h, toWater);
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) raw[i] = coastSdf(kind[i], toLand[i], toWater[i]);
  const kindAt = (x: number, y: number) => kind[y * w + x];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out[(y * w + x) * 4] = encodeCoastSdf(
        blurredSdf(raw, kindAt, w, h, x, y),
      );
    }
  }

  // G: moisture from the distance to water (rivers included) and forests.
  if (features !== null && features.length === n) {
    for (let i = 0; i < n; i++) {
      const f = features[i] & 3;
      if (f >= 2) mask[i] = 1;
    }
    squaredDistanceTransform(mask, w, h, toWater);
  }
  const forest = new Float32Array(n);
  if (features !== null && features.length === n) {
    for (let i = 0; i < n; i++) mask[i] = (features[i] & 3) === 1 ? 1 : 0;
    squaredDistanceTransform(mask, w, h, forest);
  } else {
    forest.fill(Infinity);
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const d = Math.sqrt(toWater[i]);
      let m = Math.exp(-d / MOISTURE_RANGE);
      m += 0.55 * Math.exp(-Math.sqrt(forest[i]) / 16);
      // Broad wet and dry regions, so interiors aren't all desert.
      m +=
        0.32 * gradientNoise(x / 140 + 3.1, y / 140 - 1.7, 307) +
        0.14 * gradientNoise(x / 47, y / 47, 311);
      out[i * 4 + 1] = Math.round(255 * Math.min(1, Math.max(0, m)));
      out[i * 4 + 2] = Math.round(255 * coldAt(y, h));
      const v =
        0.5 +
        0.32 * gradientNoise(x / 110 - 7.3, y / 110 + 2.9, 401) +
        0.18 * gradientNoise(x / 37 + 1.1, y / 37 - 4.4, 409);
      out[i * 4 + 3] = Math.round(255 * Math.min(1, Math.max(0, v)));
    }
  }
  return out;
}

export interface CoastRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Patch the coast distance (R) after land turned to water inside `rects`
 * (`terrain` is current). Every tile within COAST_PATCH_RADIUS of a changed
 * rect is recomputed by a local search, which reaches as far as the field
 * saturates. Moisture and cold are left alone. Returns the patched rects.
 */
export function updateClimateForFlood(
  field: Uint8Array,
  terrain: Uint8Array,
  w: number,
  h: number,
  rects: readonly CoastRect[],
): CoastRect[] {
  const R = COAST_PATCH_RADIUS;
  const reach = Math.ceil(COAST_SDF_RANGE + 0.5);
  const out: CoastRect[] = [];
  for (const r of rects) {
    const x0 = Math.max(0, r.x - R);
    const y0 = Math.max(0, r.y - R);
    const x1 = Math.min(w, r.x + r.w + R);
    const y1 = Math.min(h, r.y + r.h + R);
    if (x1 <= x0 || y1 <= y0) continue;
    // Raw distances for the rect plus the blur's one-tile apron.
    const ax0 = Math.max(0, x0 - 1);
    const ay0 = Math.max(0, y0 - 1);
    const ax1 = Math.min(w, x1 + 1);
    const ay1 = Math.min(h, y1 + 1);
    const ww = ax1 - ax0;
    const wh = ay1 - ay0;
    const raw = new Float32Array(ww * wh);
    for (let y = ay0; y < ay1; y++) {
      for (let x = ax0; x < ax1; x++) {
        const k = kindOf(terrain[y * w + x]);
        let sqLand = Infinity;
        let sqWater = Infinity;
        for (let dy = -reach; dy <= reach; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -reach; dx <= reach; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const kk = kindOf(terrain[yy * w + xx]);
            const sq = dx * dx + dy * dy;
            if (kk === LAND && sq < sqLand) sqLand = sq;
            else if (kk === WATER && sq < sqWater) sqWater = sq;
          }
        }
        raw[(y - ay0) * ww + (x - ax0)] = coastSdf(k, sqLand, sqWater);
      }
    }
    const kindAt = (wx: number, wy: number) =>
      kindOf(terrain[(wy + ay0) * w + wx + ax0]);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        field[(y * w + x) * 4] = encodeCoastSdf(
          blurredSdf(raw, kindAt, ww, wh, x - ax0, y - ay0),
        );
      }
    }
    out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }
  return out;
}
