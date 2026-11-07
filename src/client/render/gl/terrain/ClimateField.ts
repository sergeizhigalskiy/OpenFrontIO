/**
 * ClimateField — the climate fields (ClimateData.ts) on the GPU: signed
 * coast distance, moisture, cold and broad albedo variation, one RGBA8
 * texel per tile, LINEAR-filtered.
 *
 * Built at load, rebuilt once the map's terrain features arrive (rivers and
 * forests make the ground around them wetter), and patched around floods.
 */

import type { TerrainRect } from "../../types";
import { createTexture2D } from "../utils/GlUtils";
import { buildClimateField, updateClimateForFlood } from "./ClimateData";

export class ClimateField {
  readonly tex: WebGLTexture;
  private field: Uint8Array;

  constructor(
    private gl: WebGL2RenderingContext,
    terrainBytes: Uint8Array,
    readonly mapW: number,
    readonly mapH: number,
  ) {
    this.field = buildClimateField(terrainBytes, mapW, mapH);
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

  /** Rebuild with the map's terrain features (rivers, forests). */
  setFeatures(terrain: Uint8Array, features: Uint8Array | null): void {
    this.field = buildClimateField(terrain, this.mapW, this.mapH, features);
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      this.mapW,
      this.mapH,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.field,
    );
  }

  /** Patch the coast around flooded rects and re-upload what changed. */
  applyTerrainRects(rects: readonly TerrainRect[], terrain: Uint8Array): void {
    if (rects.length === 0) return;
    const dirty = updateClimateForFlood(
      this.field,
      terrain,
      this.mapW,
      this.mapH,
      rects,
    );
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
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
