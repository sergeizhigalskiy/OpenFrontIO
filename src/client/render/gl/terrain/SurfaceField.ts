/**
 * SurfaceField — the per-tile surface fields (SurfaceData.ts) on the GPU:
 * water depth, coast distance, wall distance and palette elevation, one
 * RGBA8 texel per tile, LINEAR-filtered so the terrain shader reads smooth
 * gradients from tile data.
 *
 * Built once at load. The CPU copy stays so a flood (water nuke, rising
 * tide) can be patched locally and re-uploaded; see updateSurfaceForFlood.
 */

import type { TerrainRect } from "../../types";
import { createTexture2D } from "../utils/GlUtils";
import { buildSurfaceField, updateSurfaceForFlood } from "./SurfaceData";

export class SurfaceField {
  readonly tex: WebGLTexture;
  private field: Uint8Array;

  constructor(
    private gl: WebGL2RenderingContext,
    terrainBytes: Uint8Array,
    readonly mapW: number,
    readonly mapH: number,
  ) {
    this.field = buildSurfaceField(terrainBytes, mapW, mapH);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.tex = createTexture2D(gl, {
      width: mapW,
      height: mapH,
      internalFormat: gl.RGBA8,
      format: gl.RGBA,
      type: gl.UNSIGNED_BYTE,
      data: this.field,
      filter: gl.LINEAR,
    });
  }

  /**
   * Patch the fields after terrain changed inside `rects` (land → water) and
   * re-upload what changed. `terrain` is the current map's terrain bytes.
   */
  applyTerrainRects(rects: readonly TerrainRect[], terrain: Uint8Array): void {
    if (rects.length === 0) return;
    const dirty = updateSurfaceForFlood(
      this.field,
      terrain,
      this.mapW,
      this.mapH,
      rects,
    );
    if (dirty.length === 0) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    // Rows of the CPU copy are contiguous, so each dirty rect uploads from it
    // directly with an unpack row length.
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, this.mapW);
    for (const r of dirty) {
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        r.x,
        r.y,
        r.w,
        r.h,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        this.field,
        (r.y * this.mapW + r.x) * 4,
      );
    }
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
  }

  dispose(): void {
    this.gl.deleteTexture(this.tex);
  }
}
