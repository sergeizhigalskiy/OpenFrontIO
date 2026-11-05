/**
 * HeightField — the smoothed per-tile elevation, on the CPU and the GPU.
 *
 * GPU: an RG8 texture, LINEAR-filtered. R = smoothed height (Relief.ts
 * units / 255), G = 255 on tiles the hillshade may shade (land that isn't
 * impassable), read with texelFetch so it stays tile-crisp. The terrain pass
 * derives normals from R; in 3D mode the surface mesh samples R for vertex
 * heights.
 *
 * CPU: the same smoothed heights (one byte per tile) for ray-cast picking.
 * The raw terrain bytes are not retained — rect updates (water nukes) read
 * a fresh copy from the terrain source, like TerrainPass re-bakes do.
 */

import type { TerrainRect } from "../../types";
import { createTexture2D } from "../utils/GlUtils";
import {
  HEIGHT_UNITS_PER_LEVEL,
  isShadedTile,
  sampleHeight,
  smoothHeights,
} from "./Relief";

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
      internalFormat: gl.RG8,
      format: gl.RG,
      type: gl.UNSIGNED_BYTE,
      data: this.packRect(terrainBytes, 0, 0, mapW, mapH, mapW),
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
        gl.RG,
        gl.UNSIGNED_BYTE,
        this.packRect(terrain, x0, y0, w, h, this.mapW),
      );
    }
  }

  /** Interleave smoothed height (R) and shade mask (G) for a rect. */
  private packRect(
    terrain: Uint8Array,
    x0: number,
    y0: number,
    w: number,
    h: number,
    stride: number,
  ): Uint8Array {
    const out = new Uint8Array(w * h * 2);
    let o = 0;
    for (let y = y0; y < y0 + h; y++) {
      const row = y * stride;
      for (let x = x0; x < x0 + w; x++) {
        out[o++] = this.heights[row + x];
        out[o++] = isShadedTile(terrain[row + x]) ? 255 : 0;
      }
    }
    return out;
  }

  dispose(): void {
    this.gl.deleteTexture(this.tex);
  }
}
