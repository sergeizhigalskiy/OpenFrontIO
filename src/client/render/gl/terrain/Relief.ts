/**
 * Terrain relief math — pure functions, no GL.
 *
 * The map stores one terrain byte per tile (see GameMapImpl): bit 7 isLand,
 * bit 6 isShoreline, bit 5 isOcean, bits 0-4 magnitude. For land the
 * magnitude is the elevation (0-30, 31 = impassable); for water it is the
 * distance to land, which we ignore — the water surface is flat.
 *
 * Heights are stored as bytes in "height units": HEIGHT_UNITS_PER_LEVEL per
 * elevation level, land lifted LAND_BASE_LEVELS above the water so coasts get
 * a visible lip. A small binomial blur turns the 31 quantized levels into a
 * continuous surface the 3D mesh and picking read. The terrain shader's
 * hillshade reads the same blur taken over land only (SurfaceData.ts), so
 * inland the shading follows the geometry exactly; at coasts and walls it
 * keeps the land's own slope instead of the dip toward sea level.
 *
 * World axes: x east, y south (down the screen), z up out of the map.
 */

/** Height-map units per elevation level (keeps the max under 256). */
export const HEIGHT_UNITS_PER_LEVEL = 7;
/** Land sits this many levels above the water surface. */
export const LAND_BASE_LEVELS = 2;
/** Highest raw height a tile can have (land, magnitude 30). */
export const MAX_RAW_HEIGHT = (LAND_BASE_LEVELS + 30) * HEIGHT_UNITS_PER_LEVEL;

const LAND_BIT = 0x80;
const MAGNITUDE_MASK = 0x1f;
const IMPASSABLE_MAGNITUDE = 31;

/**
 * Raw height of one tile from its terrain byte. Water and impassable tiles
 * are 0: impassable renders as the map background, so it reads as "outside
 * the map" at sea level rather than as a raised plateau.
 */
export function rawHeightOf(terrainByte: number): number {
  if ((terrainByte & LAND_BIT) === 0) return 0;
  const magnitude = terrainByte & MAGNITUDE_MASK;
  if (magnitude === IMPASSABLE_MAGNITUDE) return 0;
  return (LAND_BASE_LEVELS + magnitude) * HEIGHT_UNITS_PER_LEVEL;
}

/** True for tiles the hillshade darkens/lightens (land that isn't impassable). */
export function isShadedTile(terrainByte: number): boolean {
  return (
    (terrainByte & LAND_BIT) !== 0 &&
    (terrainByte & MAGNITUDE_MASK) !== IMPASSABLE_MAGNITUDE
  );
}

/** Rows processed per band by smoothHeights (bounds the scratch buffer). */
const SMOOTH_BAND_ROWS = 256;

/**
 * Write the smoothed height field for the rect [x0,x1)×[y0,y1) into `out`
 * (map-sized, row-major). Separable 5-tap binomial blur [1,4,6,4,1]/16 with
 * clamp-to-edge, reading raw heights straight from the terrain bytes. Tiles
 * outside the rect are read but not written, so a sub-rect update after a
 * terrain change matches a full rebuild exactly.
 */
export function smoothHeights(
  terrain: Uint8Array,
  w: number,
  h: number,
  out: Uint8Array,
  x0 = 0,
  y0 = 0,
  x1 = w,
  y1 = h,
): void {
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(w, x1);
  y1 = Math.min(h, y1);
  const rw = x1 - x0;
  if (rw <= 0 || y1 <= y0) return;
  // Horizontal pass result for band rows plus a 2-row apron on each side.
  // Max value 224 * 16 = 3584 fits in Uint16.
  const scratch = new Uint16Array(rw * (SMOOTH_BAND_ROWS + 4));
  for (let by = y0; by < y1; by += SMOOTH_BAND_ROWS) {
    const bandEnd = Math.min(y1, by + SMOOTH_BAND_ROWS);
    // Horizontal pass over rows by-2 .. bandEnd+1 (clamped).
    for (let sy = by - 2; sy < bandEnd + 2; sy++) {
      const row = Math.min(h - 1, Math.max(0, sy)) * w;
      const dst = (sy - (by - 2)) * rw;
      for (let x = x0; x < x1; x++) {
        const xm2 = x - 2 < 0 ? 0 : x - 2;
        const xm1 = x - 1 < 0 ? 0 : x - 1;
        const xp1 = x + 1 >= w ? w - 1 : x + 1;
        const xp2 = x + 2 >= w ? w - 1 : x + 2;
        scratch[dst + x - x0] =
          rawHeightOf(terrain[row + xm2]) +
          4 * rawHeightOf(terrain[row + xm1]) +
          6 * rawHeightOf(terrain[row + x]) +
          4 * rawHeightOf(terrain[row + xp1]) +
          rawHeightOf(terrain[row + xp2]);
      }
    }
    // Vertical pass. Sum ≤ 3584 * 16 = 57344; /256 with rounding.
    for (let y = by; y < bandEnd; y++) {
      const s = (y - (by - 2)) * rw;
      const outRow = y * w;
      for (let i = 0; i < rw; i++) {
        const sum =
          scratch[s - 2 * rw + i] +
          4 * scratch[s - rw + i] +
          6 * scratch[s + i] +
          4 * scratch[s + rw + i] +
          scratch[s + 2 * rw + i];
        out[outRow + x0 + i] = (sum + 128) >> 8;
      }
    }
  }
}

/**
 * Bilinear sample of a byte height field at world position (x, y), matching
 * a LINEAR-filtered, clamp-to-edge GPU texture: texel (i, j) is centred at
 * (i + 0.5, j + 0.5). Returns raw height units (0-255).
 */
export function sampleHeight(
  heights: Uint8Array,
  w: number,
  h: number,
  x: number,
  y: number,
): number {
  const fx = Math.min(w - 1, Math.max(0, x - 0.5));
  const fy = Math.min(h - 1, Math.max(0, y - 0.5));
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = fx - ix;
  const ty = fy - iy;
  const ix1 = Math.min(w - 1, ix + 1);
  const iy1 = Math.min(h - 1, iy + 1);
  const r0 = iy * w;
  const r1 = iy1 * w;
  const top = heights[r0 + ix] * (1 - tx) + heights[r0 + ix1] * tx;
  const bottom = heights[r1 + ix] * (1 - tx) + heights[r1 + ix1] * tx;
  return top * (1 - ty) + bottom * ty;
}

export type Vec3 = [number, number, number];

/**
 * Unit light direction (pointing from the ground toward the light) for a
 * compass azimuth (0 = north, 90 = east, clockwise) and an altitude above the
 * horizon, both in degrees. North is -y in world space.
 */
export function lightDirection(azimuthDeg: number, altitudeDeg: number): Vec3 {
  const az = (azimuthDeg * Math.PI) / 180;
  const alt = (altitudeDeg * Math.PI) / 180;
  const horiz = Math.cos(alt);
  return [Math.sin(az) * horiz, -Math.cos(az) * horiz, Math.sin(alt)];
}

/**
 * Surface normal from central differences of the four neighbouring heights
 * (left/right along x, up/down = north/south along y), each one tile from
 * the centre. `zScale` converts height units to world tiles.
 */
export function reliefNormal(
  left: number,
  right: number,
  up: number,
  down: number,
  zScale: number,
): Vec3 {
  const dx = ((right - left) * zScale) / 2;
  const dy = ((down - up) * zScale) / 2;
  const len = Math.hypot(dx, dy, 1);
  return [-dx / len, -dy / len, 1 / len];
}

/** Bounds for the hillshade multiplier, so shading never crushes the palette. */
export const MIN_SHADE = 0.55;
export const MAX_SHADE = 1.4;
/** Slopes turned from the light darken by this share of their full Lambert. */
export const SHADOW_SOFTNESS = 0.72;

/**
 * Brightness multiplier for a surface normal under `light` — the core of the
 * terrain shader's hillshade (shaders/terrain/terrain.frag.glsl, which adds a
 * coast bevel, hollow/ridge shading and wall shadows on top). Flat ground
 * maps to exactly 1, so the terrain palette is untouched where there's no
 * relief; slopes facing the light brighten and slopes facing away darken,
 * softened so deep relief doesn't swallow the palette. `strength` scales the
 * effect (0 = off).
 */
export function hillshadeFactor(
  normal: Vec3,
  light: Vec3,
  strength: number,
): number {
  const lambert = Math.max(
    0,
    normal[0] * light[0] + normal[1] * light[1] + normal[2] * light[2],
  );
  const relief = lambert / Math.max(1e-3, light[2]) - 1;
  const soft = relief < 0 ? relief * SHADOW_SOFTNESS : relief;
  const shade = 1 + strength * soft;
  return Math.min(MAX_SHADE, Math.max(MIN_SHADE, shade));
}

/**
 * Apply a hillshade factor to an 8-bit colour channel: darken by
 * multiplying, lighten by blending toward white (multiplying would clip the
 * near-white mountain colours and lose their detail).
 */
export function shadeChannel(channel: number, factor: number): number {
  if (factor <= 1) return channel * factor;
  return channel + (255 - channel) * (factor - 1) * 0.5;
}
