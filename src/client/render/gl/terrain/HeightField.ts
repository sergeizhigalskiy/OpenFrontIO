/**
 * HeightField — the relief heights (ReliefHeights.ts), on the CPU and the
 * GPU.
 *
 * GPU: an R16F texture, LINEAR-filtered: height units / 255. In the 3D modes
 * the surface mesh samples it for vertex heights (the camera include's
 * uHeightMap); the terrain and territory shaders take their surface normals
 * from it in every mode, and the relief bake (ReliefBake.ts) casts its
 * shadows and ambient occlusion from it.
 *
 * CPU: the same heights (height units per tile) for ray-cast picking. The
 * raw terrain bytes are not retained — rect updates (water nukes) read a
 * fresh copy from the terrain source, like TerrainPass re-bakes do.
 */

import type { TerrainRect } from "../../types";
import { createTexture2D } from "../utils/GlUtils";
import { HEIGHT_UNITS_PER_LEVEL, sampleHeight } from "./Relief";
import { buildReliefHeights, RELIEF_APRON } from "./ReliefHeights";

export class HeightField {
  readonly tex: WebGLTexture;
  /** Relief heights, height units, row-major. */
  readonly heights: Float32Array;
  /**
   * Highest level present on this map. Terrain changes only ever lower land
   * (land → water), so this stays a valid upper bound.
   */
  readonly peakLevel: number;
  /** Union of the rects changed since the last takeDirty(), or null. */
  private dirty: TerrainRect | null = null;

  constructor(
    private gl: WebGL2RenderingContext,
    private terrainSource: () => Uint8Array,
    terrainBytes: Uint8Array,
    readonly mapW: number,
    readonly mapH: number,
  ) {
    this.heights = new Float32Array(mapW * mapH);
    buildReliefHeights(terrainBytes, mapW, mapH, this.heights);
    let peak = 0;
    for (let i = 0; i < this.heights.length; i++) {
      if (this.heights[i] > peak) peak = this.heights[i];
    }
    this.peakLevel = peak / HEIGHT_UNITS_PER_LEVEL;
    const normalized = new Float32Array(this.heights.length);
    for (let i = 0; i < normalized.length; i++) {
      normalized[i] = this.heights[i] / 255;
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.tex = createTexture2D(gl, {
      width: mapW,
      height: mapH,
      internalFormat: gl.R16F,
      format: gl.RED,
      type: gl.FLOAT,
      data: normalized,
      filter: gl.LINEAR,
    });
  }

  /** Height in elevation levels at world (x, y), bilinear like the GPU. */
  levelAt(x: number, y: number): number {
    return (
      sampleHeight(this.heights, this.mapW, this.mapH, x, y) /
      HEIGHT_UNITS_PER_LEVEL
    );
  }

  /**
   * Rebuild and re-upload the regions around changed terrain rects (e.g.
   * land → water from a water nuke). A tile's height depends on terrain up
   * to RELIEF_APRON tiles away, so the update covers that apron too.
   */
  applyTerrainRects(rects: readonly TerrainRect[]): void {
    if (rects.length === 0) return;
    const terrain = this.terrainSource();
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    for (const r of rects) {
      const x0 = Math.max(0, r.x - RELIEF_APRON);
      const y0 = Math.max(0, r.y - RELIEF_APRON);
      const x1 = Math.min(this.mapW, r.x + r.w + RELIEF_APRON);
      const y1 = Math.min(this.mapH, r.y + r.h + RELIEF_APRON);
      buildReliefHeights(
        terrain,
        this.mapW,
        this.mapH,
        this.heights,
        x0,
        y0,
        x1,
        y1,
      );
      const w = x1 - x0;
      const h = y1 - y0;
      const rows = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        const src = (y0 + y) * this.mapW + x0;
        for (let x = 0; x < w; x++) {
          rows[y * w + x] = this.heights[src + x] / 255;
        }
      }
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, w, h, gl.RED, gl.FLOAT, rows);
      this.markDirty({ x: x0, y: y0, w, h });
    }
  }

  /** The area changed since the last call (null if none), then forget it. */
  takeDirty(): TerrainRect | null {
    const d = this.dirty;
    this.dirty = null;
    return d;
  }

  private markDirty(r: TerrainRect): void {
    const d = this.dirty;
    if (d === null) {
      this.dirty = { ...r };
      return;
    }
    const x0 = Math.min(d.x, r.x);
    const y0 = Math.min(d.y, r.y);
    const x1 = Math.max(d.x + d.w, r.x + r.w);
    const y1 = Math.max(d.y + d.h, r.y + r.h);
    this.dirty = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  dispose(): void {
    this.gl.deleteTexture(this.tex);
  }
}
