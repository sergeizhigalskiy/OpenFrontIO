/**
 * Relief heights — the displaced ground the 3D mesh, the lighting and the
 * picking all share. Pure functions, no GL; HeightField uploads them.
 *
 * The map only stores a quantized elevation per tile (magnitude 0-30), so
 * a blur of it reads as soft rounded lumps. Here the elevation is smoothed
 * just enough to hide the 31 terrace steps, then given landforms it can't
 * express on its own:
 *   - mountains get ridged noise: sharp crests and cut valleys, scaled by
 *     how mountainous the ground is, so ranges read as ridgelines
 *   - hills and highlands get gentler rolling relief
 *   - plains a faint undulation
 *   - coasts sit low: land eases down to the water over a few tiles, so
 *     beaches meet the sea, while mountains on a coast still rise steeply
 *
 * The noise is a fixed hash of tile coordinates, so every client builds the
 * same heights, and a rect rebuilt after a flood matches a full build
 * exactly (each tile depends only on tiles within APRON of it).
 *
 * Units: height units, HEIGHT_UNITS_PER_LEVEL per elevation level (Relief.ts),
 * so mapView.heightScale keeps its meaning (world tiles per level).
 */

import { HEIGHT_UNITS_PER_LEVEL, LAND_BASE_LEVELS } from "./Relief";

const LAND_BIT = 0x80;
const MAGNITUDE_MASK = 0x1f;
const IMPASSABLE_MAGNITUDE = 31;

/** Radius of the coast ramp's land count (tiles). */
const COAST_RADIUS = 3;
/** Elevation smoothing weights (radius 2, within the apron). */
const BINOMIAL5 = [1, 4, 6, 4, 1] as const;
/** Every tile depends on terrain within this many tiles of it. */
export const RELIEF_APRON = COAST_RADIUS;

/** Peak-to-trough relief the ridges add to the highest mountains, levels. */
export const RIDGE_LEVELS = 6.5;
/** Rolling relief on hills and highlands, levels. */
const HILL_LEVELS = 1.6;
/** Undulation on plains, levels. */
const PLAIN_LEVELS = 0.5;
/** Ridge wavelengths, tiles (coarse to fine). */
const RIDGE_WAVELENGTHS = [19, 9, 4.3] as const;
const RIDGE_WEIGHTS = [0.55, 0.3, 0.15] as const;

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------

function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Gradient (Perlin) noise, about -1..1, one lattice cell per unit. */
export function gradientNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const g = (cx: number, cy: number, dx: number, dy: number): number => {
    // One of 8 directions per lattice point.
    const a = (hash(cx, cy, seed) & 7) * (Math.PI / 4);
    return Math.cos(a) * dx + Math.sin(a) * dy;
  };
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const n00 = g(ix, iy, fx, fy);
  const n10 = g(ix + 1, iy, fx - 1, fy);
  const n01 = g(ix, iy + 1, fx, fy - 1);
  const n11 = g(ix + 1, iy + 1, fx - 1, fy - 1);
  const nx0 = n00 + (n10 - n00) * u;
  const nx1 = n01 + (n11 - n01) * u;
  return (nx0 + (nx1 - nx0) * v) * 1.41;
}

/** Ridged multi-octave noise, 0..1: 1 along crests, falling into valleys. */
export function ridgedNoise(x: number, y: number): number {
  let sum = 0;
  for (let i = 0; i < RIDGE_WAVELENGTHS.length; i++) {
    const s = 1 / RIDGE_WAVELENGTHS[i];
    // Offset each octave so their crests don't line up.
    const n = gradientNoise(x * s + i * 17.3, y * s - i * 9.1, 101 + i);
    const r = 1 - Math.min(1, Math.abs(n));
    sum += RIDGE_WEIGHTS[i] * r * r;
  }
  return sum;
}

/** Smooth multi-octave noise, about -1..1. */
function rollingNoise(x: number, y: number, wavelength: number): number {
  const s = 1 / wavelength;
  return (
    0.65 * gradientNoise(x * s, y * s, 211) +
    0.35 * gradientNoise(x * s * 2.1 + 5.2, y * s * 2.1 - 3.7, 223)
  );
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// Heights
// ---------------------------------------------------------------------------

function isPassableLand(b: number): boolean {
  return (b & LAND_BIT) !== 0 && (b & MAGNITUDE_MASK) !== IMPASSABLE_MAGNITUDE;
}

/**
 * Relief height (height units) of one land tile from its smoothed elevation
 * `level`, the share of passable land around it (`landShare`, 0-1) and its
 * position.
 */
export function reliefHeight(
  level: number,
  landShare: number,
  x: number,
  y: number,
): number {
  const mountain = smoothstep(9, 22, level);
  const hill = smoothstep(2, 11, level) * (1 - mountain);
  const px = x + 0.5;
  const py = y + 0.5;
  let h = LAND_BASE_LEVELS + level;
  if (mountain > 0) {
    // Crests rise above the range's average height, valleys cut below it.
    h += mountain * RIDGE_LEVELS * (ridgedNoise(px, py) - 0.42);
  }
  if (hill > 0) h += hill * HILL_LEVELS * rollingNoise(px, py, 11);
  h += (1 - mountain) * PLAIN_LEVELS * rollingNoise(px, py, 27);
  // Coasts sit low; a steep coast (a mountain at the sea) keeps its rise.
  const coast = 0.22 + 0.78 * smoothstep(0.32, 0.95, landShare);
  h *= coast;
  return Math.max(0.25, h) * HEIGHT_UNITS_PER_LEVEL;
}

/**
 * Write relief heights for the rect [x0,x1)×[y0,y1) into `out` (map-sized,
 * row-major, height units). Water and impassable tiles are 0. Reads terrain
 * up to RELIEF_APRON tiles outside the rect.
 */
export function buildReliefHeights(
  terrain: Uint8Array,
  w: number,
  h: number,
  out: Float32Array,
  x0 = 0,
  y0 = 0,
  x1 = w,
  y1 = h,
): void {
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(w, x1);
  y1 = Math.min(h, y1);
  if (x1 <= x0 || y1 <= y0) return;
  const R = COAST_RADIUS;
  // Window: the rect plus the apron, clamped to the map.
  const wx0 = Math.max(0, x0 - R);
  const wy0 = Math.max(0, y0 - R);
  const wx1 = Math.min(w, x1 + R);
  const wy1 = Math.min(h, y1 + R);
  const ww = wx1 - wx0;
  const wh = wy1 - wy0;
  const land = new Uint8Array(ww * wh);
  for (let y = wy0; y < wy1; y++) {
    for (let x = wx0; x < wx1; x++) {
      land[(y - wy0) * ww + (x - wx0)] = isPassableLand(terrain[y * w + x])
        ? 1
        : 0;
    }
  }
  // Horizontal land counts over 2R+1 tiles (map edges count as land, so the
  // map's border doesn't read as a coast).
  const span = 2 * R + 1;
  const rowSum = new Uint8Array(ww * wh);
  for (let y = 0; y < wh; y++) {
    // Only the rect's columns are read back; their reach stays in the window.
    for (let x = x0 - wx0; x < x1 - wx0; x++) {
      let s = 0;
      for (let d = -R; d <= R; d++) {
        const gx = wx0 + x + d;
        s += gx < 0 || gx >= w ? 1 : land[y * ww + x + d];
      }
      rowSum[y * ww + x] = s;
    }
  }
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * w + x;
      if (!isPassableLand(terrain[i])) {
        out[i] = 0;
        continue;
      }
      // Share of land around the tile.
      let count = 0;
      for (let d = -R; d <= R; d++) {
        const gy = y + d;
        count += gy < 0 || gy >= h ? span : rowSum[(gy - wy0) * ww + (x - wx0)];
      }
      const share = count / (span * span);
      // Elevation, smoothed over land only ([1,4,6,4,1] binomial), so the
      // level steps don't show as terraces; the crisp shapes come from the
      // landforms below.
      let num = 0;
      let den = 0;
      for (let dy = -2; dy <= 2; dy++) {
        const gy = y + dy;
        if (gy < 0 || gy >= h) continue;
        const wy = BINOMIAL5[dy + 2];
        for (let dx = -2; dx <= 2; dx++) {
          const gx = x + dx;
          if (gx < 0 || gx >= w) continue;
          const b = terrain[gy * w + gx];
          if (!isPassableLand(b)) continue;
          const wt = wy * BINOMIAL5[dx + 2];
          num += wt * (b & MAGNITUDE_MASK);
          den += wt;
        }
      }
      const level = den > 0 ? num / den : 0;
      out[i] = reliefHeight(level, share, x, y);
    }
  }
}
