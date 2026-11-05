/**
 * TerrainNoise — a small tileable noise texture for surface detail: the
 * water's moving shimmer, gentle colour variation across the land, and the
 * forest canopy. Generated once (64×64, a few KB) with a fixed seed, so
 * every client draws the same pattern.
 *
 * RG8, REPEAT, mipmapped so it fades to its average instead of shimmering
 * when the map is zoomed out:
 *   R  smooth value noise, three octaves (features 16, 8 and 4 texels)
 *   G  cellular "crowns": 1 at a jittered point per 8×8 cell, falling to 0
 *      halfway to the next — round blobs, one per cell
 */

export const NOISE_SIZE = 64;
const CROWN_CELL = 8;

/** Deterministic hash of integer lattice coordinates to [0, 1). */
function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Tileable value noise with `cells` lattice cells across the texture. */
function valueNoise(x: number, y: number, cells: number, seed: number): number {
  const s = NOISE_SIZE / cells;
  const fx = x / s;
  const fy = y / s;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = fade(fx - ix);
  const ty = fade(fy - iy);
  const at = (cx: number, cy: number) =>
    hash2(((cx % cells) + cells) % cells, ((cy % cells) + cells) % cells, seed);
  const a = at(ix, iy);
  const b = at(ix + 1, iy);
  const c = at(ix, iy + 1);
  const d = at(ix + 1, iy + 1);
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

/** Rescale `v` to span 0-255. */
function normalized(v: Float32Array): Uint8Array {
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of v) {
    lo = Math.min(lo, x);
    hi = Math.max(hi, x);
  }
  return Uint8Array.from(v, (x) => Math.round(((x - lo) / (hi - lo)) * 255));
}

/** RG bytes, NOISE_SIZE² texels. */
export function buildTerrainNoise(): Uint8Array {
  const n = NOISE_SIZE;
  const smooth = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      smooth[y * n + x] =
        0.5 * valueNoise(x, y, 4, 11) +
        0.3 * valueNoise(x, y, 8, 23) +
        0.2 * valueNoise(x, y, 16, 37);
    }
  }
  const smoothBytes = normalized(smooth);
  // Crown centres, one per cell, jittered inside the middle of the cell.
  const cells = n / CROWN_CELL;
  const cx = new Float32Array(cells * cells);
  const cy = new Float32Array(cells * cells);
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      cx[j * cells + i] = (i + 0.2 + 0.6 * hash2(i, j, 51)) * CROWN_CELL;
      cy[j * cells + i] = (j + 0.2 + 0.6 * hash2(i, j, 73)) * CROWN_CELL;
    }
  }
  const out = new Uint8Array(n * n * 2);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const ci = Math.floor(px / CROWN_CELL);
      const cj = Math.floor(py / CROWN_CELL);
      let best = Infinity;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const i = (((ci + di) % cells) + cells) % cells;
          const j = (((cj + dj) % cells) + cells) % cells;
          // Wrap the centre to the neighbouring copy of the tile.
          const ox = cx[j * cells + i] + (ci + di - i) * CROWN_CELL;
          const oy = cy[j * cells + i] + (cj + dj - j) * CROWN_CELL;
          const d = Math.hypot(px - ox, py - oy);
          if (d < best) best = d;
        }
      }
      const crown = Math.max(0, 1 - best / (0.62 * CROWN_CELL));
      const i = y * n + x;
      out[i * 2] = smoothBytes[i];
      out[i * 2 + 1] = Math.round(Math.sqrt(crown) * 255);
    }
  }
  return out;
}

/** Upload the noise as an RG8, REPEAT, trilinear-filtered texture. */
export function createTerrainNoiseTexture(
  gl: WebGL2RenderingContext,
): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RG8,
    NOISE_SIZE,
    NOISE_SIZE,
    0,
    gl.RG,
    gl.UNSIGNED_BYTE,
    buildTerrainNoise(),
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(
    gl.TEXTURE_2D,
    gl.TEXTURE_MIN_FILTER,
    gl.LINEAR_MIPMAP_LINEAR,
  );
  gl.generateMipmap(gl.TEXTURE_2D);
  return tex;
}
