/**
 * GPU-ready color utilities.
 *
 * Terrain RGBA: Uint8Array(w × h × 4) — one RGBA pixel per tile, computed
 * from the terrain color rules applied to the raw terrain byte layout.
 *
 * Player palette is NOT built here — consumers provide a pre-built
 * Float32Array(PALETTE_SIZE × 2 × 4) to the GPURenderer constructor.
 */

import renderDefaults from "../render-settings.json";

/** Must cover 12-bit smallID range (0-4095). */
const PALETTE_SIZE = 4096;

export function getPaletteSize(): number {
  return PALETTE_SIZE;
}

/**
 * Max colors per trail gradient = rows per block in the trail-effect texture.
 * Longer catalog color lists are truncated. Shared so the CPU side that fills
 * the texture and the GPU side that allocates it can't drift.
 */
export const MAX_TRAIL_COLORS = 8;

/**
 * The effect-palette texture stacks one MAX_TRAIL_COLORS-row block per
 * trail-styled effectType: block 0 = transportShipTrail, block 1 = nukeTrail
 * (matching the nuke bit in trail.frag.glsl), block 2 = structures (read by
 * structure.frag.glsl), block 3 = warship and block 4 = train (both read by
 * unit.frag.glsl), block 5 = railroad (read by railroad.frag.glsl). Bump this
 * if another trail-styled effectType is added (and give its consumer shader
 * the new rowBase).
 */
export const EFFECT_PALETTE_BLOCKS = 6;

/** Block index of the structures effect within the effect-palette texture. */
export const STRUCTURES_EFFECT_BLOCK = 2;

/** Block index of the warship effect within the effect-palette texture. */
export const WARSHIP_EFFECT_BLOCK = 3;

/** Block index of the train effect within the effect-palette texture. */
export const TRAIN_EFFECT_BLOCK = 4;

/** Block index of the railroad effect within the effect-palette texture. */
export const RAILROAD_EFFECT_BLOCK = 5;

// ---------- Terrain ----------

/** Parse a "#rrggbb" (or "rrggbb") hex string into an RGB tuple, or null. */
export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

type Rgb = readonly [number, number, number];

/** A "#rrggbb" default from render-settings.json, as RGB. */
function defaultColor(hex: string): Rgb {
  return hexToRgb(hex)!;
}

/** Terrain colours a player may override in graphics settings. */
export interface TerrainColorOverrides {
  backgroundColor?: Rgb;
  oceanColor?: Rgb;
  sandColor?: Rgb;
  plainsColor?: Rgb;
  highlandColor?: Rgb;
  mountainColor?: Rgb;
}

/**
 * The terrain palette, 0-255 RGB: the base colours the terrain shader
 * (shaders/terrain/terrain.frag.glsl) builds every surface colour from.
 *   background  impassable terrain, and the clear colour outside the map
 *   ocean       open water a few tiles out; the shader lightens it toward
 *               the shore and darkens it with depth
 *   sand        beaches along low coasts
 *   plains, highland  the land palette by elevation (bare rock above the
 *               highlands is derived from the highland colour)
 *   mountain    the highest peaks: snow by default
 */
export interface TerrainPalette {
  background: Rgb;
  ocean: Rgb;
  sand: Rgb;
  plains: Rgb;
  highland: Rgb;
  mountain: Rgb;
}

/**
 * The palette from settings, falling back to the defaults in
 * render-settings.json (`terrain.*`, the single source of truth).
 */
export function resolveTerrainPalette(
  colors?: TerrainColorOverrides,
): TerrainPalette {
  const d = renderDefaults.terrain;
  return {
    background: colors?.backgroundColor ?? defaultColor(d.backgroundColor),
    ocean: colors?.oceanColor ?? defaultColor(d.oceanColor),
    sand: colors?.sandColor ?? defaultColor(d.sandColor),
    plains: colors?.plainsColor ?? defaultColor(d.plainsColor),
    highland: colors?.highlandColor ?? defaultColor(d.highlandColor),
    mountain: colors?.mountainColor ?? defaultColor(d.mountainColor),
  };
}

/**
 * Flat base colour of one tile from its terrain byte, written as RGBA into
 * `out[offset..offset+3]` — the palette entry the shader starts from,
 * without its smoothing, depth shading, features or relief. For code that
 * needs a tile's colour without the GPU.
 *
 * Terrain byte layout per tile:
 *   bit 7: isLand
 *   bit 6: isShoreline
 *   bit 5: isOcean  (water only)
 *   bits 0-4: magnitude (0-31)
 *
 * Impassable terrain is encoded as isLand=1 + magnitude=31. It takes the map
 * background colour (matching `gl.clearColor` in Renderer.ts) so the map
 * appears non-rectangular: impassable regions read as outside the map.
 */
export function encodeTerrainTile(
  tb: number,
  out: Uint8Array,
  offset: number,
  colors?: TerrainColorOverrides,
): void {
  const palette = resolveTerrainPalette(colors);
  const isLand = (tb & 0x80) !== 0;
  const isShoreline = (tb & 0x40) !== 0;
  const magnitude = tb & 0x1f;

  let rgb: Rgb;
  if (!isLand) rgb = palette.ocean;
  else if (magnitude === 31) rgb = palette.background;
  else if (isShoreline) rgb = palette.sand;
  else if (magnitude < 10) rgb = palette.plains;
  else if (magnitude < 20) rgb = palette.highland;
  else rgb = palette.mountain;

  out[offset] = rgb[0];
  out[offset + 1] = rgb[1];
  out[offset + 2] = rgb[2];
  out[offset + 3] = 255;
}
