/**
 * Surface mesh — pure chunk selection, level of detail and mesh building for
 * the 3D terrain. No GL; MapSurface uploads what this builds.
 *
 * The map is split into square chunks of CHUNK_SIZE tiles. Each visible chunk
 * gets a level: its vertex spacing is 2^level tiles, chosen so vertices land
 * about `targetPx` pixels apart on screen. Vertices carry only their world
 * (x, y); vertex shaders read the height from the height map (groundToClip),
 * so every pass that draws the surface drapes onto the same geometry.
 *
 * Cracks between chunks of different levels are closed by snapping: on an
 * edge shared with a coarser neighbour, the finer chunk's edge vertices move
 * onto the neighbour's vertex positions, so both sides trace the same
 * polyline through the same height samples. Triangles are emitted north to
 * south; the camera looks north, so that is back-to-front and the surface
 * needs no depth buffer.
 */

import type { CameraFrame } from "../camera/CameraMath";

export const CHUNK_SIZE = 64;
/** Coarsest level: one quad per chunk. */
export const MAX_LEVEL = Math.log2(CHUNK_SIZE);

export interface SurfaceSelection {
  cols: number;
  rows: number;
  /** Level per chunk (row-major, cols × rows); -1 = not drawn. */
  levels: Int8Array;
}

export interface SurfaceOptions {
  /** Upper bound of terrain height (world tiles), for conservative culling. */
  maxHeight: number;
  /** Target on-screen vertex spacing, pixels. */
  targetPx: number;
}

/**
 * Pick the visible chunks and a level for each. A chunk is culled when its
 * bounding box (ground to maxHeight) lies entirely outside one frustum plane;
 * its level comes from the pixels-per-tile at its nearest corner.
 */
export function selectSurfaceChunks(
  frame: CameraFrame,
  mapW: number,
  mapH: number,
  opts: SurfaceOptions,
  out?: SurfaceSelection,
): SurfaceSelection {
  const cols = Math.ceil(mapW / CHUNK_SIZE);
  const rows = Math.ceil(mapH / CHUNK_SIZE);
  const sel =
    out !== undefined && out.cols === cols && out.rows === rows
      ? out
      : { cols, rows, levels: new Int8Array(cols * rows) };
  const m = frame.viewProj;
  const zTop = Math.max(0, opts.maxHeight);
  const [ex, ey, ez] = frame.eye;
  const [fx, fy, fz] = frame.forward;
  const near = frame.focusDist * 0.01;
  for (let cy = 0; cy < rows; cy++) {
    const y0 = cy * CHUNK_SIZE;
    const y1 = Math.min(mapH, y0 + CHUNK_SIZE);
    for (let cx = 0; cx < cols; cx++) {
      const x0 = cx * CHUNK_SIZE;
      const x1 = Math.min(mapW, x0 + CHUNK_SIZE);
      // Outcodes: a bit per clip plane that every corner is outside of.
      let allOut = 0b11111;
      let minDepth = Infinity;
      for (let c = 0; c < 8; c++) {
        const x = c & 1 ? x1 : x0;
        const y = c & 2 ? y1 : y0;
        const z = c & 4 ? zTop : 0;
        const px = m[0] * x + m[4] * y + m[8] * z + m[12];
        const py = m[1] * x + m[5] * y + m[9] * z + m[13];
        const pz = m[2] * x + m[6] * y + m[10] * z + m[14];
        const pw = m[3] * x + m[7] * y + m[11] * z + m[15];
        let code = 0;
        if (px < -pw) code |= 1;
        if (px > pw) code |= 2;
        if (py < -pw) code |= 4;
        if (py > pw) code |= 8;
        if (pz < -pw) code |= 16;
        allOut &= code;
        const depth = (x - ex) * fx + (y - ey) * fy + (z - ez) * fz;
        if (depth < minDepth) minDepth = depth;
      }
      const index = cy * cols + cx;
      if (allOut !== 0) {
        sel.levels[index] = -1;
        continue;
      }
      sel.levels[index] = chunkLevel(frame, minDepth, near, opts.targetPx);
    }
  }
  return sel;
}

/** Level for a chunk whose nearest point is `depth` in front of the camera. */
export function chunkLevel(
  frame: CameraFrame,
  depth: number,
  near: number,
  targetPx: number,
): number {
  const pxPerTile = frame.perspective
    ? (frame.zoom * frame.focusDist) / Math.max(depth, near)
    : frame.zoom;
  const level = Math.floor(Math.log2(targetPx / Math.max(pxPerTile, 1e-6)));
  return Math.max(0, Math.min(MAX_LEVEL, level));
}

export interface SurfaceMeshData {
  /** World (x, y) per vertex. */
  positions: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  indexCount: number;
}

/** Vertex offsets along a chunk edge of length `len` at spacing `step`. */
function edgeOffsets(len: number, step: number): number[] {
  const out: number[] = [];
  for (let p = 0; p < len; p += step) out.push(p);
  out.push(len);
  return out;
}

/** Snap an interior edge offset onto a coarser neighbour's vertex grid. */
function snap(p: number, coarseStep: number, len: number): number {
  return Math.min(len, Math.round(p / coarseStep) * coarseStep);
}

/**
 * Build the mesh for a selection. Buffers are reused when large enough.
 */
export function buildSurfaceMesh(
  sel: SurfaceSelection,
  mapW: number,
  mapH: number,
  reuse?: SurfaceMeshData,
): SurfaceMeshData {
  const { cols, rows, levels } = sel;
  // Size the buffers first.
  let vertexCount = 0;
  let quadCount = 0;
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i];
    if (level < 0) continue;
    const cx = i % cols;
    const cy = (i - cx) / cols;
    const step = 1 << level;
    const nx = Math.ceil(Math.min(CHUNK_SIZE, mapW - cx * CHUNK_SIZE) / step);
    const ny = Math.ceil(Math.min(CHUNK_SIZE, mapH - cy * CHUNK_SIZE) / step);
    vertexCount += (nx + 1) * (ny + 1);
    quadCount += nx * ny;
  }
  const positions =
    reuse !== undefined && reuse.positions.length >= vertexCount * 2
      ? reuse.positions
      : new Float32Array(Math.ceil(vertexCount * 2 * 1.25));
  const indices =
    reuse !== undefined && reuse.indices.length >= quadCount * 6
      ? reuse.indices
      : new Uint32Array(Math.ceil(quadCount * 6 * 1.25));

  const levelAt = (cx: number, cy: number): number =>
    cx < 0 || cy < 0 || cx >= cols || cy >= rows ? -1 : levels[cy * cols + cx];

  // Per chunk: first vertex, column count. Kept for the row-ordered emit.
  const base = new Int32Array(levels.length);
  const stride = new Int32Array(levels.length);
  const rowYs: number[][] = [];
  let v = 0;
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i];
    rowYs.push([]);
    if (level < 0) continue;
    const cx = i % cols;
    const cy = (i - cx) / cols;
    const x0 = cx * CHUNK_SIZE;
    const y0 = cy * CHUNK_SIZE;
    const lenX = Math.min(CHUNK_SIZE, mapW - x0);
    const lenY = Math.min(CHUNK_SIZE, mapH - y0);
    const step = 1 << level;
    const xs = edgeOffsets(lenX, step);
    const ys = edgeOffsets(lenY, step);
    rowYs[i] = ys;
    // Coarser neighbours set the snap step for each edge (0 = no snap).
    const coarser = (n: number) => (n > level ? 1 << n : 0);
    const north = coarser(levelAt(cx, cy - 1));
    const south = coarser(levelAt(cx, cy + 1));
    const west = coarser(levelAt(cx - 1, cy));
    const east = coarser(levelAt(cx + 1, cy));
    base[i] = v;
    stride[i] = xs.length;
    const lastX = xs.length - 1;
    const lastY = ys.length - 1;
    for (let j = 0; j <= lastY; j++) {
      for (let k = 0; k <= lastX; k++) {
        let px = xs[k];
        let py = ys[j];
        const interiorX = k > 0 && k < lastX;
        const interiorY = j > 0 && j < lastY;
        if (j === 0 && north && interiorX) px = snap(px, north, lenX);
        else if (j === lastY && south && interiorX) px = snap(px, south, lenX);
        if (k === 0 && west && interiorY) py = snap(py, west, lenY);
        else if (k === lastX && east && interiorY) py = snap(py, east, lenY);
        positions[v * 2] = x0 + px;
        positions[v * 2 + 1] = y0 + py;
        v++;
      }
    }
  }

  // Emit quads north to south across each chunk row (back-to-front): for
  // every local row offset, the cell row starting there in each chunk.
  let n = 0;
  for (let cy = 0; cy < rows; cy++) {
    for (let y = 0; y < CHUNK_SIZE; y++) {
      for (let cx = 0; cx < cols; cx++) {
        const i = cy * cols + cx;
        const level = levels[i];
        if (level < 0 || (y & ((1 << level) - 1)) !== 0) continue;
        const j = y >> level;
        if (j + 1 >= rowYs[i].length) continue;
        emitRow(i, j);
      }
    }
  }
  return { positions, indices, vertexCount: v, indexCount: n };

  /** Two triangles per cell of row j in chunk i (diagonal a–e). */
  function emitRow(i: number, j: number): void {
    const w = stride[i];
    const row0 = base[i] + j * w;
    const row1 = row0 + w;
    for (let k = 0; k + 1 < w; k++) {
      const a = row0 + k;
      const b = a + 1;
      const d = row1 + k;
      const e = d + 1;
      indices[n++] = a;
      indices[n++] = b;
      indices[n++] = e;
      indices[n++] = a;
      indices[n++] = e;
      indices[n++] = d;
    }
  }
}
