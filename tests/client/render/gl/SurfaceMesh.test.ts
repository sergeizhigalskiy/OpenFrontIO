import { describe, expect, it } from "vitest";
import {
  computeCameraFrame,
  ndcToRay,
  pixelToNdc,
  worldToPixel,
  type CameraPose,
} from "../../../../src/client/render/gl/camera/CameraMath";
import {
  pickGround,
  raycastHeightfield,
} from "../../../../src/client/render/gl/camera/MapViewSource";
import {
  buildSurfaceMesh,
  CHUNK_SIZE,
  chunkLevel,
  MAX_LEVEL,
  selectSurfaceChunks,
  type SurfaceSelection,
} from "../../../../src/client/render/gl/terrain/SurfaceMesh";

const POSE: CameraPose = {
  centerX: 1000,
  centerY: 700,
  zoom: 1.5,
  viewW: 1600,
  viewH: 900,
  tiltDeg: 30,
  fovDeg: 40,
};

describe("chunk selection", () => {
  it("culls chunks outside the view and keeps the ones under it", () => {
    const frame = computeCameraFrame(POSE);
    const sel = selectSurfaceChunks(frame, 4000, 3000, {
      maxHeight: 10,
      targetPx: 10,
    });
    expect(sel.cols).toBe(Math.ceil(4000 / CHUNK_SIZE));
    expect(sel.rows).toBe(Math.ceil(3000 / CHUNK_SIZE));
    const at = (x: number, y: number) =>
      sel.levels[
        Math.floor(y / CHUNK_SIZE) * sel.cols + Math.floor(x / CHUNK_SIZE)
      ];
    expect(at(1000, 700)).toBeGreaterThanOrEqual(0); // focus
    expect(at(3900, 2900)).toBe(-1); // far off-screen
    expect(at(10, 10)).toBe(-1);
    // Every chunk whose centre projects inside the viewport is drawn.
    for (let cy = 0; cy < sel.rows; cy++) {
      for (let cx = 0; cx < sel.cols; cx++) {
        const p = worldToPixel(
          frame,
          (cx + 0.5) * CHUNK_SIZE,
          (cy + 0.5) * CHUNK_SIZE,
        );
        if (p !== null && p.x > 0 && p.x < 1600 && p.y > 0 && p.y < 900) {
          expect(sel.levels[cy * sel.cols + cx]).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it("gets coarser with distance", () => {
    const frame = computeCameraFrame({ ...POSE, zoom: 0.6 });
    const sel = selectSurfaceChunks(frame, 4000, 3000, {
      maxHeight: 10,
      targetPx: 10,
    });
    // Down the column under the focus: north (far) to south (near).
    const col = Math.floor(1000 / CHUNK_SIZE);
    const visible: number[] = [];
    for (let cy = 0; cy < sel.rows; cy++) {
      const level = sel.levels[cy * sel.cols + col];
      if (level >= 0) visible.push(level);
    }
    expect(visible.length).toBeGreaterThan(4);
    for (let i = 1; i < visible.length; i++) {
      expect(visible[i]).toBeLessThanOrEqual(visible[i - 1]);
    }
    expect(visible[0]).toBeGreaterThan(visible[visible.length - 1]);
  });

  it("picks the level from on-screen vertex spacing", () => {
    const frame = computeCameraFrame(POSE);
    const at = (depth: number) => chunkLevel(frame, depth, 1, 10);
    // At the focus a tile is `zoom` pixels: 10px / 1.5px → spacing 4 tiles.
    expect(at(frame.focusDist)).toBe(2);
    // Twice as far, tiles are half the size → one level coarser.
    expect(at(frame.focusDist * 2)).toBe(3);
    // Zoomed far in: one vertex per tile.
    const close = computeCameraFrame({ ...POSE, zoom: 40 });
    expect(chunkLevel(close, close.focusDist, 1, 10)).toBe(0);
    expect(at(1e9)).toBe(MAX_LEVEL);
  });
});

/** Positions of the vertices a mesh places on the line x = c (or y = c). */
function edgeVertices(
  positions: Float32Array,
  count: number,
  axis: 0 | 1,
  c: number,
  from: number,
  to: number,
): number[] {
  const out = new Set<number>();
  for (let i = 0; i < count; i++) {
    const on = positions[i * 2 + axis];
    const along = positions[i * 2 + (1 - axis)];
    if (on === c && along >= from && along <= to) out.add(along);
  }
  return [...out].sort((a, b) => a - b);
}

function selection(
  cols: number,
  rows: number,
  levels: number[],
): SurfaceSelection {
  return { cols, rows, levels: Int8Array.from(levels) };
}

describe("surface mesh", () => {
  it("covers a chunk with a regular grid at its level", () => {
    const mesh = buildSurfaceMesh(selection(1, 1, [3]), 64, 64);
    const n = 64 / 8 + 1;
    expect(mesh.vertexCount).toBe(n * n);
    expect(mesh.indexCount).toBe((n - 1) * (n - 1) * 6);
    for (let i = 0; i < mesh.indexCount; i++) {
      expect(mesh.indices[i]).toBeLessThan(mesh.vertexCount);
    }
  });

  it("clips partial chunks at the map edge", () => {
    const mesh = buildSurfaceMesh(selection(2, 1, [2, 2]), 100, 30);
    let maxX = 0;
    let maxY = 0;
    for (let i = 0; i < mesh.vertexCount; i++) {
      maxX = Math.max(maxX, mesh.positions[i * 2]);
      maxY = Math.max(maxY, mesh.positions[i * 2 + 1]);
    }
    expect(maxX).toBe(100);
    expect(maxY).toBe(30);
  });

  it("leaves no cracks where levels meet", () => {
    // Fine chunk (level 1) between coarser neighbours on every side.
    const levels = [5, 3, 5, 4, 1, 6, 5, 2, 5];
    const mesh = buildSurfaceMesh(selection(3, 3, levels), 192, 192);
    const { positions, vertexCount } = mesh;
    const C = CHUNK_SIZE;
    // Shared edges of the centre chunk: both sides place the same vertices.
    const north = edgeVertices(positions, vertexCount, 1, C, C, 2 * C);
    const south = edgeVertices(positions, vertexCount, 1, 2 * C, C, 2 * C);
    const west = edgeVertices(positions, vertexCount, 0, C, C, 2 * C);
    const east = edgeVertices(positions, vertexCount, 0, 2 * C, C, 2 * C);
    const grid = (step: number) =>
      Array.from({ length: C / step + 1 }, (_, i) => C + i * step);
    expect(north).toEqual(grid(8)); // neighbour level 3
    expect(south).toEqual(grid(4)); // neighbour level 2
    expect(west).toEqual(grid(16)); // neighbour level 4
    expect(east).toEqual(grid(64)); // neighbour level 6
  });

  it("emits rows north to south (back to front for the camera)", () => {
    // Mixed levels side by side; no west neighbour is coarser, so the first
    // vertex of every cell keeps its row's y.
    const mesh = buildSurfaceMesh(selection(2, 2, [1, 3, 1, 3]), 128, 128);
    let lastY = -Infinity;
    for (let i = 0; i < mesh.indexCount; i += 6) {
      const a = mesh.indices[i];
      const top = mesh.positions[a * 2 + 1];
      expect(top).toBeGreaterThanOrEqual(lastY);
      lastY = top;
    }
  });

  it("builds nothing for an empty selection", () => {
    const mesh = buildSurfaceMesh(selection(2, 1, [-1, -1]), 128, 64);
    expect(mesh.vertexCount).toBe(0);
    expect(mesh.indexCount).toBe(0);
  });
});

describe("ray-cast picking against the terrain", () => {
  const frame = computeCameraFrame(POSE);
  // A smooth hill 8 tiles high centred on (1000, 680).
  const hill = (x: number, y: number) =>
    8 * Math.exp(-((x - 1000) ** 2 + (y - 680) ** 2) / 400);

  it("hits flat ground where the plane intersection does", () => {
    const [nx, ny] = pixelToNdc(frame, 500, 300);
    const ray = ndcToRay(frame, nx, ny);
    const plane = pickGround(ray, null)!;
    const terrain = raycastHeightfield(ray, () => 0, 5)!;
    expect(terrain.x).toBeCloseTo(plane.x, 3);
    expect(terrain.y).toBeCloseTo(plane.y, 3);
  });

  it("lands on the visible slope, short of the ground behind it", () => {
    // Pixel where the hilltop is drawn.
    const top = worldToPixel(frame, 1000, 680, hill(1000, 680))!;
    const [nx, ny] = pixelToNdc(frame, top.x, top.y);
    const ray = ndcToRay(frame, nx, ny);
    const hit = raycastHeightfield(ray, hill, 8)!;
    expect(hit.x).toBeCloseTo(1000, 1);
    expect(hit.y).toBeCloseTo(680, 0);
    // The flat-ground pick for the same pixel is well north of the hill.
    const flat = pickGround(ray, null)!;
    expect(flat.y).toBeLessThan(hit.y - 3);
    // The reported point sits on the surface.
    const z = ray.origin[2] + ray.dir[2] * hit.t;
    expect(z).toBeCloseTo(hill(hit.x, hit.y), 1);
  });

  it("round-trips through the source the renderer exposes", () => {
    const source = { heightAt: hill, maxHeight: () => 8 };
    for (const [x, y] of [
      [995, 690],
      [1010, 675],
      [980, 700],
    ]) {
      const p = worldToPixel(frame, x, y, hill(x, y))!;
      const [nx, ny] = pixelToNdc(frame, p.x, p.y);
      const hit = pickGround(ndcToRay(frame, nx, ny), source)!;
      expect(hit.x).toBeCloseTo(x, 1);
      expect(hit.y).toBeCloseTo(y, 1);
    }
  });

  it("misses rays that point up", () => {
    expect(
      raycastHeightfield({ origin: [0, 0, 10], dir: [0, 1, 0.1] }, hill, 8),
    ).toBeNull();
  });
});
