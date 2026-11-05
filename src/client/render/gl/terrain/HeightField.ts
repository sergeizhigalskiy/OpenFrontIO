/**
 * HeightField — the smoothed per-tile elevation, on the CPU and the GPU.
 *
 * GPU: an R8 texture, LINEAR-filtered: smoothed height (Relief.ts units /
 * 255). In 3D mode the surface mesh samples it for vertex heights (the
 * camera include's uHeightMap). The terrain shader's hillshade reads the
 * land-only elevation in the SurfaceField instead.
 *
 * CPU: the same smoothed heights (one byte per tile) for ray-cast picking.
 * The raw terrain bytes are not retained — rect updates (water nukes) read
 * a fresh copy from the terrain source, like TerrainPass re-bakes do.
 */

import type { TerrainRect } from "../../types";
import { createTexture2D } from "../utils/GlUtils";
import { HEIGHT_UNITS_PER_LEVEL, sampleHeight, smoothHeights } from "./Relief";

/** Blur radius of smoothHeights — a terrain change dirties this much around it. */
const SMOOTH_RADIUS = 2;

export class HeightField {
  readonly tex: WebGLTexture;
  /** Smoothed heights, raw units (0..MAX_RAW_HEIGHT), row-major. */
  readonly heights: Uint8Array;
  /**
   * Highest level present on this map. Terrain changes only ever lower land
   * (land → water), so this stays a valid upper bound.
   */
  readonly peakLevel: number;

  constructor(
    private gl: WebGL2RenderingContext,
    private terrainSource: () => Uint8Array,
    terrainBytes: Uint8Array,
    readonly mapW: number,
    readonly mapH: number,
  ) {
    this.heights = new Uint8Array(mapW * mapH);
    smoothHeights(terrainBytes, mapW, mapH, this.heights);
    let peak = 0;
    for (let i = 0; i < this.heights.length; i++) {
      if (this.heights[i] > peak) peak = this.heights[i];
    }
    this.peakLevel = peak / HEIGHT_UNITS_PER_LEVEL;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.tex = createTexture2D(gl, {
      width: mapW,
      height: mapH,
      internalFormat: gl.R8,
      format: gl.RED,
      type: gl.UNSIGNED_BYTE,
      data: this.heights,
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
   * Re-smooth and re-upload the regions around changed terrain rects (e.g.
   * land → water from a water nuke). The blur reaches SMOOTH_RADIUS tiles past
   * each rect, so the update covers that apron too.
   */
  applyTerrainRects(rects: readonly TerrainRect[]): void {
    if (rects.length === 0) return;
    const terrain = this.terrainSource();
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    // Upload each rect straight from the height rows.
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, this.mapW);
    for (const r of rects) {
      const x0 = Math.max(0, r.x - SMOOTH_RADIUS);
      const y0 = Math.max(0, r.y - SMOOTH_RADIUS);
      const x1 = Math.min(this.mapW, r.x + r.w + SMOOTH_RADIUS);
      const y1 = Math.min(this.mapH, r.y + r.h + SMOOTH_RADIUS);
      smoothHeights(
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
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        x0,
        y0,
        w,
        h,
        gl.RED,
        gl.UNSIGNED_BYTE,
        this.heights,
        y0 * this.mapW + x0,
      );
    }
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
  }

  dispose(): void {
    this.gl.deleteTexture(this.tex);
  }
}
