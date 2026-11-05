/**
 * Surface data — per-tile fields the terrain shader reads to colour water by
 * depth, draw beaches and coast bevels, shade the ground beside impassable
 * walls, and blend the land palette smoothly. Pure functions, no GL;
 * SurfaceField.ts uploads what this builds.
 *
 * One RGBA8 texel per tile, sampled LINEAR so every field is continuous:
 *   R  water depth: distance from a water tile to the nearest shore,
 *      sqrt-encoded over WATER_DEPTH_RANGE tiles (fine steps near the shore)
 *   G  coast distance: distance from a land tile to the nearest water,
 *      COAST_UNITS per tile up to COAST_RANGE
 *   B  wall distance, signed: 128 at the edge of impassable terrain, up
 *      outside it and down inside it, WALL_UNITS per tile
 *   A  palette elevation: land elevation level smoothed over land only, so
 *      coasts and walls don't drag the palette down, ELEVATION_UNITS a level
 *
 * Distances run from the tile's centre to the edge of the nearest tile of the
 * other kind (centre distance - 0.5), so a bilinear sample reaches 0 right at
 * the tile boundary. Each field is also stored on the tiles it doesn't
 * describe (water depth on impassable tiles, coast distance on impassable
 * tiles, elevation on water), extended from its neighbours, so filtering
 * across those edges never drags in a meaningless 0.
 *
 * Distances are exact Euclidean (Felzenszwalb's separable transform), derived
 * once at load. Terrain changes afterwards only ever turn passable land into
 * water (nukes, rising tides); updateSurfaceForFlood patches the fields around
 * each newly flooded tile instead of redoing the whole map.
 */

const LAND_BIT = 0x80;
const MAGNITUDE_MASK = 0x1f;
const IMPASSABLE_MAGNITUDE = 31;

/** Water depth (R) saturates at this many tiles from land. */
export const WATER_DEPTH_RANGE = 64;
/** Coast distance (G) units per tile, and the distance it saturates at. */
export const COAST_UNITS = 32;
export const COAST_RANGE = 255 / COAST_UNITS;
/** Signed wall distance (B) units per tile; 128 is the wall's edge. */
export const WALL_UNITS = 8;
/** Palette elevation (A) units per elevation level (levels 0-30). */
export const ELEVATION_UNITS = 8;

/** Tile kinds the fields are built from. */
const WATER = 0;
const LAND = 1;
const WALL = 2;

function kindOf(terrainByte: number): number {
  if ((terrainByte & LAND_BIT) === 0) return WATER;
  return (terrainByte & MAGNITUDE_MASK) === IMPASSABLE_MAGNITUDE ? WALL : LAND;
}

export function encodeWaterDepth(tiles: number): number {
  const t = Math.min(1, Math.max(0, tiles) / WATER_DEPTH_RANGE);
  return Math.round(255 * Math.sqrt(t));
}

/** Inverse of encodeWaterDepth (what the shader does after filtering). */
export function decodeWaterDepth(byte: number): number {
  const t = byte / 255;
  return t * t * WATER_DEPTH_RANGE;
}

export function encodeCoastDistance(tiles: number): number {
  return Math.min(255, Math.round(Math.max(0, tiles) * COAST_UNITS));
}

/** Signed: positive outside impassable terrain, negative inside it. */
export function encodeWallDistance(signedTiles: number): number {
  return Math.min(255, Math.max(0, Math.round(128 + signedTiles * WALL_UNITS)));
}

// ---------------------------------------------------------------------------
// Distance transform
// ---------------------------------------------------------------------------

/**
 * Exact squared Euclidean distance from every tile to the nearest tile where
 * `isSource` is set, written into `out` (Infinity when there is no source).
 * Felzenszwalb & Huttenlocher's separable transform: columns, then rows.
 */
export function squaredDistanceTransform(
  isSource: Uint8Array,
  w: number,
  h: number,
  out: Float32Array,
): void {
  const n = Math.max(w, h);
  const f = new Float32Array(n);
  const d = new Float32Array(n);
  const v = new Int32Array(n);
  const z = new Float32Array(n + 1);
  for (let i = 0; i < w * h; i++) out[i] = isSource[i] ? 0 : Infinity;
  for (let x = 0; x < w; x++) {
    for (let y = 0, i = x; y < h; y++, i += w) f[y] = out[i];
    transform1d(f, h, d, v, z);
    for (let y = 0, i = x; y < h; y++, i += w) out[i] = d[y];
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = out[row + x];
    transform1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[row + x] = d[x];
  }
}

/** 1D squared distance transform of the sampled function f (lower envelope). */
function transform1d(
  f: Float32Array,
  n: number,
  d: Float32Array,
  v: Int32Array,
  z: Float32Array,
): void {
  let k = -1;
  for (let q = 0; q < n; q++) {
    const fq = f[q];
    if (fq === Infinity) continue;
    if (k < 0) {
      k = 0;
      v[0] = q;
      z[0] = -Infinity;
      z[1] = Infinity;
      continue;
    }
    // Drop the parabolas q hides; z[0] = -Infinity stops this at k = 0.
    let s = 0;
    for (;;) {
      const p = v[k];
      s = (fq + q * q - (f[p] + p * p)) / (2 * (q - p));
      if (s > z[k]) break;
      k--;
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  if (k < 0) {
    d.fill(Infinity, 0, n);
    return;
  }
  let j = 0;
  for (let q = 0; q < n; q++) {
    while (z[j + 1] < q) j++;
    const p = v[j];
    d[q] = (q - p) * (q - p) + f[p];
  }
}

// ---------------------------------------------------------------------------
// Palette elevation
// ---------------------------------------------------------------------------

const BINOMIAL = [1, 4, 6, 4, 1];

/**
 * Palette elevation (A) for the rect [x0,x1)×[y0,y1): the 5×5 binomial
 * average of the elevation level over passable land only (normalized
 * convolution), so a tile's colour never mixes in water or walls. Tiles with
 * no land within two tiles get 0.
 */
function writeElevation(
  terrain: Uint8Array,
  w: number,
  h: number,
  out: Uint8Array,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      let sum = 0;
      let weight = 0;
      for (let dy = -2; dy <= 2; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        const wy = BINOMIAL[dy + 2];
        const row = yy * w;
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const tb = terrain[row + xx];
          if (kindOf(tb) !== LAND) continue;
          const wt = wy * BINOMIAL[dx + 2];
          sum += wt * (tb & MAGNITUDE_MASK);
          weight += wt;
        }
      }
      out[(y * w + x) * 4 + 3] =
        weight > 0 ? Math.round((sum / weight) * ELEVATION_UNITS) : 0;
    }
  }
}

/**
 * Separable version of writeElevation for the whole map (same result, far
 * fewer reads): blur level×landMask and landMask, then divide.
 */
function writeElevationFull(
  kind: Uint8Array,
  terrain: Uint8Array,
  w: number,
  h: number,
  out: Uint8Array,
): void {
  const n = w * h;
  // Level and weight per tile (both 0 off passable land).
  const level = new Uint8Array(n);
  const weight = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (kind[i] === LAND) {
      level[i] = terrain[i] & MAGNITUDE_MASK;
      weight[i] = 1;
    }
  }
  // Horizontal pass: sums ≤ 30 × 16 and 16.
  const num = new Uint16Array(n);
  const den = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      let s = 6 * level[i];
      let c = 6 * weight[i];
      if (x >= 1) {
        s += 4 * level[i - 1];
        c += 4 * weight[i - 1];
      }
      if (x >= 2) {
        s += level[i - 2];
        c += weight[i - 2];
      }
      if (x < w - 1) {
        s += 4 * level[i + 1];
        c += 4 * weight[i + 1];
      }
      if (x < w - 2) {
        s += level[i + 2];
        c += weight[i + 2];
      }
      num[i] = s;
      den[i] = c;
    }
  }
  // Vertical pass, then divide.
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      let s = 6 * num[i];
      let c = 6 * den[i];
      if (y >= 1) {
        s += 4 * num[i - w];
        c += 4 * den[i - w];
      }
      if (y >= 2) {
        s += num[i - 2 * w];
        c += den[i - 2 * w];
      }
      if (y < h - 1) {
        s += 4 * num[i + w];
        c += 4 * den[i + w];
      }
      if (y < h - 2) {
        s += num[i + 2 * w];
        c += den[i + 2 * w];
      }
      out[i * 4 + 3] = c > 0 ? Math.round((s * ELEVATION_UNITS) / c) : 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Build and update
// ---------------------------------------------------------------------------

/**
 * Lookup table from an integer squared distance to an encoded byte, up to
 * where the encoding saturates (the last entry is the saturated value).
 */
function encodingTable(encode: (tiles: number) => number): Uint8Array {
  const out: number[] = [];
  const last = encode(1e9);
  for (let sq = 0; ; sq++) {
    const v = encode(Math.sqrt(sq));
    out.push(v);
    if (v === last) break;
  }
  return Uint8Array.from(out);
}

/**
 * Mark the tiles of kind `a` that have a 4-neighbour of kind `b` or `c`
 * (pass -1 for none) in `mask`; everything else is 0.
 */
function markEdges(
  kind: Uint8Array,
  w: number,
  h: number,
  a: number,
  b: number,
  c: number,
  mask: Uint8Array,
): void {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      let m = 0;
      if (kind[i] === a) {
        const l = x > 0 ? kind[i - 1] : a;
        const r = x < w - 1 ? kind[i + 1] : a;
        const u = y > 0 ? kind[i - w] : a;
        const d = y < h - 1 ? kind[i + w] : a;
        if (
          l === b ||
          r === b ||
          u === b ||
          d === b ||
          l === c ||
          r === c ||
          u === c ||
          d === c
        ) {
          m = 1;
        }
      }
      mask[i] = m;
    }
  }
}

/**
 * Build the RGBA8 surface field for a whole map (w*h*4 bytes).
 *
 * One distance transform serves both sides of the coast: its sources are the
 * land tiles that touch water. The nearest land to a water tile is such a
 * tile (unless walls stand between), so water depth is exact; a land tile's
 * distance to the water is that distance plus one tile, give or take the
 * diagonal. Walls are void, not shore: water beside them gets no shallows and
 * land beside them no beach. Wall distances come from the wall tiles that
 * touch passable ground (skipped on maps without walls).
 */
export function buildSurfaceField(
  terrain: Uint8Array,
  w: number,
  h: number,
): Uint8Array {
  const n = w * h;
  const out = new Uint8Array(n * 4);
  const kind = new Uint8Array(n);
  let walls = 0;
  for (let i = 0; i < n; i++) {
    const k = kindOf(terrain[i]);
    kind[i] = k;
    if (k === WALL) walls++;
  }
  const mask = new Uint8Array(n);
  const dist = new Float32Array(n);

  // R and G: distance to the coastline. Squared distances are integers, so
  // the encodings are table lookups.
  markEdges(kind, w, h, LAND, WATER, -1, mask);
  squaredDistanceTransform(mask, w, h, dist);
  const depthLut = encodingTable((d) => encodeWaterDepth(d - 0.5));
  const coastLut = encodingTable((d) => encodeCoastDistance(d + 0.5));
  for (let i = 0; i < n; i++) {
    const sq = dist[i];
    const k = kind[i];
    const o = i * 4;
    if (k !== LAND) out[o] = sq < depthLut.length ? depthLut[sq] : 255;
    // Walls carry the coast distance too, so filtering across them is flat.
    if (k !== WATER) out[o + 1] = sq < coastLut.length ? coastLut[sq] : 255;
  }

  // B: signed distance to the edge of impassable terrain.
  if (walls === 0) {
    for (let i = 0; i < n; i++) out[i * 4 + 2] = 255;
  } else {
    markEdges(kind, w, h, WALL, LAND, WATER, mask);
    squaredDistanceTransform(mask, w, h, dist);
    const outside = encodingTable((d) => encodeWallDistance(d - 0.5));
    const inside = encodingTable((d) => encodeWallDistance(-(d + 0.5)));
    for (let i = 0; i < n; i++) {
      const sq = dist[i];
      const lut = kind[i] === WALL ? inside : outside;
      out[i * 4 + 2] = sq < lut.length ? lut[sq] : lut[lut.length - 1];
    }
  }

  // A: palette elevation.
  writeElevationFull(kind, terrain, w, h, out);
  return out;
}

/** How far around a flooded tile the fields are patched. */
export const FLOOD_PATCH_RADIUS = 8;

export interface DirtyRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Patch `field` (from buildSurfaceField) after terrain changes inside the
 * rects; `terrain` is the current terrain. Only land → water changes happen
 * after load, so a flooded tile is one that is water now but still has
 * water depth 0 in the field. Around each one:
 *   - its water depth is the distance to the nearest land within
 *     FLOOD_PATCH_RADIUS (or that radius, if none is closer); water further
 *     out keeps its depth, so the old shallows stay shallow
 *   - land within the radius gets closer to the water
 *   - the palette elevation is re-averaged where the flood touched it
 * Wall distances never change (walls don't flood). Returns the rects of the
 * field that changed, for upload; empty if nothing flooded.
 */
export function updateSurfaceForFlood(
  field: Uint8Array,
  terrain: Uint8Array,
  w: number,
  h: number,
  rects: readonly DirtyRect[],
): DirtyRect[] {
  const R = FLOOD_PATCH_RADIUS;
  const dirty: DirtyRect[] = [];
  for (const r of rects) {
    const x0 = Math.max(0, r.x);
    const y0 = Math.max(0, r.y);
    const x1 = Math.min(w, r.x + r.w);
    const y1 = Math.min(h, r.y + r.h);
    let minX = w;
    let minY = h;
    let maxX = -1;
    let maxY = -1;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * w + x;
        if (kindOf(terrain[i]) !== WATER || field[i * 4] !== 0) continue;
        floodTile(field, terrain, w, h, x, y);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) continue;
    const ex0 = Math.max(0, minX - R);
    const ey0 = Math.max(0, minY - R);
    const ex1 = Math.min(w, maxX + R + 1);
    const ey1 = Math.min(h, maxY + R + 1);
    // Elevation reaches 2 tiles; redo it over the flooded box plus that.
    writeElevation(
      terrain,
      w,
      h,
      field,
      Math.max(0, minX - 2),
      Math.max(0, minY - 2),
      Math.min(w, maxX + 3),
      Math.min(h, maxY + 3),
    );
    dirty.push({ x: ex0, y: ey0, w: ex1 - ex0, h: ey1 - ey0 });
  }
  return dirty;
}

/** Patch the fields around one tile that just turned from land to water. */
function floodTile(
  field: Uint8Array,
  terrain: Uint8Array,
  w: number,
  h: number,
  x: number,
  y: number,
): void {
  const R = FLOOD_PATCH_RADIUS;
  let best = R + 0.5;
  for (let dy = -R; dy <= R; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= h) continue;
    for (let dx = -R; dx <= R; dx++) {
      const xx = x + dx;
      if (xx < 0 || xx >= w) continue;
      const k = kindOf(terrain[yy * w + xx]);
      const d = Math.sqrt(dx * dx + dy * dy);
      if (k === LAND) {
        if (d < best) best = d;
        // That land is now at most d from water.
        const gi = (yy * w + xx) * 4 + 1;
        const g = encodeCoastDistance(d - 0.5);
        if (g < field[gi]) field[gi] = g;
      }
    }
  }
  const i = (y * w + x) * 4;
  // Never 0: 0 marks land (and tells the next update this tile is new).
  field[i] = Math.max(1, encodeWaterDepth(best - 0.5));
  field[i + 1] = 0;
}

// ---------------------------------------------------------------------------
// Terrain features
// ---------------------------------------------------------------------------

/** Packed feature byte: bits 0-1 the TerrainFeature, then neighbourhood flags. */
export const FEATURE_MASK = 0x03;
/** A river or ford tile is within the tile's 3×3 neighbourhood. */
export const NEAR_WATERWAY = 0x04;
/** A forest tile is within the tile's 3×3 neighbourhood. */
export const NEAR_FOREST = 0x08;

const FOREST = 1;
const RIVER = 2;
const FORD = 3;

/**
 * Pack one TerrainFeature per tile (0 none, 1 forest, 2 river, 3 ford) with
 * flags saying what lies in the 3×3 around it, so the shader only looks at
 * neighbours where there is something to blend.
 */
export function packTerrainFeatures(
  features: Uint8Array,
  w: number,
  h: number,
): Uint8Array {
  const n = w * h;
  const own = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const f = features[i] & FEATURE_MASK;
    own[i] =
      f === FOREST
        ? NEAR_FOREST
        : f === RIVER || f === FORD
          ? NEAR_WATERWAY
          : 0;
  }
  // Dilate the flags by one tile: rows, then columns.
  const rows = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let m = own[row + x];
      if (x > 0) m |= own[row + x - 1];
      if (x < w - 1) m |= own[row + x + 1];
      rows[row + x] = m;
    }
  }
  const out = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let m = rows[i];
      if (y > 0) m |= rows[i - w];
      if (y < h - 1) m |= rows[i + w];
      out[i] = (features[i] & FEATURE_MASK) | m;
    }
  }
  return out;
}
