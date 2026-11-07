/**
 * Relief heights — the displaced ground the 3D mesh, the lighting and the
 * picking all share. Pure functions, no GL; HeightField uploads them.
 *
 * The map only stores a quantized elevation per tile (magnitude 0-30:
 * plains below 10, highlands 10-19, mountains 20-30). The elevation is
 * smoothed just enough to hide the terrace steps, then each class gets its
 * own landform, so the relief follows the map instead of covering it:
 *   - plains stay low and nearly flat
 *   - highlands rise gently, with soft rolling hills
 *   - mountains climb steeply and get ridged noise: sharp crests, spurs and
 *     valleys running down their flanks, scaled by how deep into the range
 *     a tile is, so ranges read as ridgelines and a lone mountain tile as a
 *     small peak
 *   - land slopes down to every water tile, sea or lake, so water always
 *     sits at the bottom of the ground around it, never in a pit
 *   - rivers and fords cut smooth beds: the ground along them follows the
 *     smoothed elevation with no noise, and the banks rise from it
 *
 * The noise is a fixed hash of tile coordinates, so every client builds the
 * same heights, and a rect rebuilt after a flood matches a full build
 * exactly (each tile depends only on tiles within RELIEF_APRON of it).
 *
 * Units: height units, HEIGHT_UNITS_PER_LEVEL per relief level (Relief.ts),
 * so mapView.heightScale keeps its meaning (world tiles per level).
 */

import { HEIGHT_UNITS_PER_LEVEL, LAND_BASE_LEVELS } from "./Relief";

const LAND_BIT = 0x80;
const MAGNITUDE_MASK = 0x1f;
const IMPASSABLE_MAGNITUDE = 31;
/** TerrainFeature values (one byte per tile) for waterways. */
const FEATURE_RIVER = 2;
const FEATURE_FORD = 3;

/** A river or ford: a feature that cuts a bed into the relief. */
export function isWaterwayFeature(feature: number): boolean {
  return feature === FEATURE_RIVER || feature === FEATURE_FORD;
}

/** Radius of the coast ramp's land count (tiles). */
const COAST_RADIUS = 3;
/** Elevation smoothing weights (radius 2). */
const BINOMIAL5 = [1, 4, 6, 4, 1] as const;
/** Land within this many tiles of water slopes down to it. */
const WATER_SLOPE_TILES = 4.2;
/** River banks rise back to the open ground over this many tiles. */
const RIVER_BANK_TILES = 3.2;
/** A river bed sits this share of the smoothed ground's height. */
const RIVER_BED = 0.92;
/** Every tile depends on terrain within this many tiles of it. */
export const RELIEF_APRON = 5;

/** Peak-to-trough relief the ridges add to the highest mountains, levels. */
export const RIDGE_LEVELS = 7;
/** Rolling relief on highlands, levels. */
const HILL_LEVELS = 0.9;
/** Undulation on plains, levels. */
const PLAIN_LEVELS = 0.12;
/** Ridge wavelengths, tiles (coarse to fine). */
const RIDGE_WAVELENGTHS = [17, 8, 3.9] as const;
const RIDGE_WEIGHTS = [0.55, 0.3, 0.15] as const;
/** Ridges on a flank run downhill, this many times longer than wide. */
const SPUR_STRETCH = 2.4;

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------

function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** The 8 lattice gradient directions (cos, sin of k·45°). */
const GRAD_X = Array.from({ length: 8 }, (_, k) => Math.cos((k * Math.PI) / 4));
const GRAD_Y = Array.from({ length: 8 }, (_, k) => Math.sin((k * Math.PI) / 4));

/** A lattice point's gradient (one of 8 directions) dotted with (dx, dy). */
function latticeDot(
  cx: number,
  cy: number,
  seed: number,
  dx: number,
  dy: number,
): number {
  const k = hash(cx, cy, seed) & 7;
  return GRAD_X[k] * dx + GRAD_Y[k] * dy;
}

/** Gradient (Perlin) noise, about -1..1, one lattice cell per unit. */
export function gradientNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const n00 = latticeDot(ix, iy, seed, fx, fy);
  const n10 = latticeDot(ix + 1, iy, seed, fx - 1, fy);
  const n01 = latticeDot(ix, iy + 1, seed, fx, fy - 1);
  const n11 = latticeDot(ix + 1, iy + 1, seed, fx - 1, fy - 1);
  const nx0 = n00 + (n10 - n00) * u;
  const nx1 = n01 + (n11 - n01) * u;
  return (nx0 + (nx1 - nx0) * v) * 1.41;
}

/**
 * Ridged multi-octave noise, 0..1: 1 along crests, falling into valleys.
 * `seed` picks an independent field.
 */
export function ridgedNoise(x: number, y: number, seed = 0): number {
  let sum = 0;
  for (let i = 0; i < RIDGE_WAVELENGTHS.length; i++) {
    const s = 1 / RIDGE_WAVELENGTHS[i];
    // Offset each octave so their crests don't line up.
    const n = gradientNoise(
      x * s + i * 17.3 + seed * 31.7,
      y * s - i * 9.1 - seed * 13.9,
      101 + i + seed * 7,
    );
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

/** ∫ smoothstep(e0, e1, t) dt from -∞ to x. */
function smoothstepIntegral(e0: number, e1: number, x: number): number {
  if (x <= e0) return 0;
  const span = e1 - e0;
  if (x >= e1) return span * 0.5 + (x - e1);
  const t = (x - e0) / span;
  return span * (t * t * t - (t * t * t * t) / 2);
}

// ---------------------------------------------------------------------------
// Heights
// ---------------------------------------------------------------------------

function isPassableLand(b: number): boolean {
  return (b & LAND_BIT) !== 0 && (b & MAGNITUDE_MASK) !== IMPASSABLE_MAGNITUDE;
}

/**
 * Relief levels of the smoothed map elevation (0-30), before any landform
 * noise: plains climb a quarter level per elevation step, highlands about
 * a half, mountains well over one. The slope eases between the classes so
 * the lighting shows no crease at their edges.
 */
export function elevationProfile(level: number): number {
  return (
    0.25 * level +
    0.35 * smoothstepIntegral(7, 13, level) +
    0.75 * smoothstepIntegral(17, 23, level)
  );
}

/** Where one tile sits, for reliefHeight. */
export interface ReliefSite {
  /** Smoothed elevation (0-30). */
  level: number;
  /** Its gradient, levels per tile (east, south). */
  gradX: number;
  gradY: number;
  /** Share of passable land within COAST_RADIUS (0-1). */
  landShare: number;
  /** Tiles to the nearest water tile (large when far). */
  waterDist: number;
  /** Tiles to the nearest river or ford tile (large when far or none). */
  riverDist: number;
}

/**
 * Ridged noise for a mountain tile: on a flank (steep `grad`) the crests
 * run downhill as spurs with valleys between them; on a summit or a
 * plateau, where the slope says nothing, they run every way. The flank
 * field blends four fixed orientations by how well each lines up with the
 * slope, so it turns smoothly with the range and never tears.
 */
function mountainRidges(
  px: number,
  py: number,
  gx: number,
  gy: number,
): number {
  const aniso = smoothstep(0.35, 1.6, Math.hypot(gx, gy));
  const iso = aniso < 1 ? ridgedNoise(px, py) : 0;
  if (aniso <= 0) return iso;
  const theta = Math.atan2(gy, gx);
  let sum = 0;
  let wsum = 0;
  for (let k = 0; k < 4; k++) {
    const phi = (k * Math.PI) / 4;
    // Axis alignment: a slope and its reverse give the same spurs.
    const c = Math.cos(2 * (theta - phi));
    if (c <= 0) continue;
    const wk = c * c;
    const dx = Math.cos(phi);
    const dy = Math.sin(phi);
    const u = (px * dx + py * dy) / SPUR_STRETCH;
    const v = -px * dy + py * dx;
    sum += wk * ridgedNoise(u, v, k + 1);
    wsum += wk;
  }
  return wsum > 0 ? iso + (sum / wsum - iso) * aniso : iso;
}

/** Relief height (height units) of one passable land tile at (x, y). */
export function reliefHeight(site: ReliefSite, x: number, y: number): number {
  const level = site.level;
  const mountain = smoothstep(16, 23, level);
  const hill = smoothstep(8, 14, level) * (1 - mountain);
  const px = x + 0.5;
  const py = y + 0.5;
  const ground = LAND_BASE_LEVELS + elevationProfile(level);
  let h = ground;
  if (mountain > 0) {
    // Crests rise above the range's average height, valleys cut below it.
    const ridges = mountainRidges(px, py, site.gradX, site.gradY);
    h += mountain * RIDGE_LEVELS * (ridges - 0.42);
  }
  if (hill > 0) h += hill * HILL_LEVELS * rollingNoise(px, py, 13);
  h += (1 - mountain - hill) * PLAIN_LEVELS * rollingNoise(px, py, 29);
  // Land comes down to the water: open coasts over the share of land
  // around them (beaches), any water over the distance to it (lakes and
  // inlets inside high ground, where the share alone keeps the land high).
  const byShare = 0.22 + 0.78 * smoothstep(0.32, 0.95, site.landShare);
  const byDist =
    0.18 + 0.82 * smoothstep(0.9, WATER_SLOPE_TILES, site.waterDist);
  const coast = Math.min(byShare, byDist);
  h *= coast;
  // Rivers: a smooth bed on the elevation alone, banks rising from it.
  if (site.riverDist < RIVER_BANK_TILES) {
    const bed = ground * coast * RIVER_BED;
    const bank = smoothstep(0.55, RIVER_BANK_TILES, site.riverDist);
    h = Math.min(h, bed + (h - bed) * bank);
  }
  return Math.max(0.25, h) * HEIGHT_UNITS_PER_LEVEL;
}

/** Chamfer (3-4) distance units per tile. */
const CHAMFER_UNIT = 3;
const CHAMFER_DIAG = 4;
const FAR = 0xffff;

/**
 * Approximate Euclidean distance (chamfer 3-4, in thirds of a tile) from
 * every cell of a ww×wh window to the nearest marked cell. Shortest
 * chamfer paths are monotone, so a distance up to the window margin is
 * exact for cells that far inside it.
 */
function chamferDistance(
  marked: Uint8Array,
  ww: number,
  wh: number,
): Uint16Array {
  const d = new Uint16Array(ww * wh);
  for (let i = 0; i < d.length; i++) d[i] = marked[i] ? 0 : FAR;
  for (let y = 0; y < wh; y++) {
    for (let x = 0; x < ww; x++) {
      const i = y * ww + x;
      let v = d[i];
      if (v === 0) continue;
      if (x > 0) v = Math.min(v, d[i - 1] + CHAMFER_UNIT);
      if (y > 0) {
        v = Math.min(v, d[i - ww] + CHAMFER_UNIT);
        if (x > 0) v = Math.min(v, d[i - ww - 1] + CHAMFER_DIAG);
        if (x < ww - 1) v = Math.min(v, d[i - ww + 1] + CHAMFER_DIAG);
      }
      d[i] = Math.min(v, FAR);
    }
  }
  for (let y = wh - 1; y >= 0; y--) {
    for (let x = ww - 1; x >= 0; x--) {
      const i = y * ww + x;
      let v = d[i];
      if (v === 0) continue;
      if (x < ww - 1) v = Math.min(v, d[i + 1] + CHAMFER_UNIT);
      if (y < wh - 1) {
        v = Math.min(v, d[i + ww] + CHAMFER_UNIT);
        if (x < ww - 1) v = Math.min(v, d[i + ww + 1] + CHAMFER_DIAG);
        if (x > 0) v = Math.min(v, d[i + ww - 1] + CHAMFER_DIAG);
      }
      d[i] = Math.min(v, FAR);
    }
  }
  return d;
}

/**
 * Write relief heights for the rect [x0,x1)×[y0,y1) into `out` (map-sized,
 * row-major, height units). Water and impassable tiles are 0. Reads terrain
 * (and `features`, one TerrainFeature byte per tile, when given) up to
 * RELIEF_APRON tiles outside the rect.
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
  features: Uint8Array | null = null,
): void {
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(w, x1);
  y1 = Math.min(h, y1);
  if (x1 <= x0 || y1 <= y0) return;
  const A = RELIEF_APRON;
  // Window: the rect plus the apron, clamped to the map.
  const wx0 = Math.max(0, x0 - A);
  const wy0 = Math.max(0, y0 - A);
  const wx1 = Math.min(w, x1 + A);
  const wy1 = Math.min(h, y1 + A);
  const ww = wx1 - wx0;
  const wh = wy1 - wy0;
  const land = new Uint8Array(ww * wh);
  const water = new Uint8Array(ww * wh);
  const river = new Uint8Array(ww * wh);
  let anyRiver = false;
  for (let y = wy0; y < wy1; y++) {
    for (let x = wx0; x < wx1; x++) {
      const i = y * w + x;
      const k = (y - wy0) * ww + (x - wx0);
      const b = terrain[i];
      const passable = isPassableLand(b);
      land[k] = passable ? 1 : 0;
      water[k] = (b & LAND_BIT) === 0 ? 1 : 0;
      if (features !== null && passable) {
        if (isWaterwayFeature(features[i])) {
          river[k] = 1;
          anyRiver = true;
        }
      }
    }
  }
  const waterDist = chamferDistance(water, ww, wh);
  const riverDist = anyRiver ? chamferDistance(river, ww, wh) : null;

  // Horizontal land counts over 2R+1 tiles (map edges count as land, so the
  // map's border doesn't read as a coast).
  const R = COAST_RADIUS;
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

  // Elevation, smoothed over land only ([1,4,6,4,1] binomial), so the level
  // steps don't show as terraces: for the rect and a one-tile ring, which
  // the slope's central differences read. Separable, in whole numbers (the
  // weighted sums of magnitudes and of land), so any rect sums exactly as a
  // full build does.
  const lx0 = Math.max(0, x0 - 1);
  const ly0 = Math.max(0, y0 - 1);
  const lx1 = Math.min(w, x1 + 1);
  const ly1 = Math.min(h, y1 + 1);
  const lw = lx1 - lx0;
  const bx0 = Math.max(0, lx0 - 2);
  const by0 = Math.max(0, ly0 - 2);
  const by1 = Math.min(h, ly1 + 2);
  const bh = by1 - by0;
  // Horizontal pass over the rows the vertical one reads.
  const rowMag = new Float32Array(lw * bh);
  const rowLand = new Float32Array(lw * bh);
  for (let y = by0; y < by1; y++) {
    for (let x = lx0; x < lx1; x++) {
      let m = 0;
      let l = 0;
      for (let dx = -2; dx <= 2; dx++) {
        const gx = x + dx;
        if (gx < bx0 || gx >= w) continue;
        const b = terrain[y * w + gx];
        if (!isPassableLand(b)) continue;
        const wt = BINOMIAL5[dx + 2];
        m += wt * (b & MAGNITUDE_MASK);
        l += wt;
      }
      const k = (y - by0) * lw + (x - lx0);
      rowMag[k] = m;
      rowLand[k] = l;
    }
  }
  const level = new Float32Array(lw * (ly1 - ly0));
  for (let y = ly0; y < ly1; y++) {
    for (let x = lx0; x < lx1; x++) {
      let num = 0;
      let den = 0;
      for (let dy = -2; dy <= 2; dy++) {
        const gy = y + dy;
        if (gy < by0 || gy >= by1) continue;
        const k = (gy - by0) * lw + (x - lx0);
        const wt = BINOMIAL5[dy + 2];
        num += wt * rowMag[k];
        den += wt * rowLand[k];
      }
      level[(y - ly0) * lw + (x - lx0)] = den > 0 ? num / den : 0;
    }
  }
  const levelAt = (x: number, y: number): number =>
    level[(y - ly0) * lw + (x - lx0)];

  const site: ReliefSite = {
    level: 0,
    gradX: 0,
    gradY: 0,
    landShare: 1,
    waterDist: 0,
    riverDist: Infinity,
  };
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
      const k = (y - wy0) * ww + (x - wx0);
      // Central differences; one-sided at the map's edge.
      const xl = Math.max(0, x - 1);
      const xr = Math.min(w - 1, x + 1);
      const yt = Math.max(0, y - 1);
      const yb = Math.min(h - 1, y + 1);
      site.level = levelAt(x, y);
      site.gradX = (levelAt(xr, y) - levelAt(xl, y)) / Math.max(1, xr - xl);
      site.gradY = (levelAt(x, yb) - levelAt(x, yt)) / Math.max(1, yb - yt);
      site.landShare = count / (span * span);
      site.waterDist = waterDist[k] / CHAMFER_UNIT;
      site.riverDist =
        riverDist === null ? Infinity : riverDist[k] / CHAMFER_UNIT;
      out[i] = reliefHeight(site, x, y);
    }
  }
}
