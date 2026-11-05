/**
 * TerrainPass — renders the terrain map as a textured quad.
 *
 * Initial upload happens once; incremental updates flow through
 * applyTerrainRects() so water-nuke conversions (land → water) are reflected
 * live. Vertex shader transforms the map quad by the camera mat3; fragment
 * shader samples the RGBA8 terrain texture with nearest-neighbour filtering
 * so each terrain cell stays pixel-crisp at every zoom level.
 *
 * With a relief source set (setRelief), land is hillshaded from the smoothed
 * height field: normals from neighbouring heights, one fixed light. Flat
 * ground keeps its exact palette colour; slopes brighten or darken.
 */

import type { TerrainRect } from "../../types";
import type { RenderSettings } from "../RenderSettings";
import terrainFragSrc from "../shaders/terrain/terrain.frag.glsl?raw";
import terrainVertSrc from "../shaders/terrain/terrain.vert.glsl?raw";
import { drawMapSurface } from "../terrain/MapSurface";
import { HEIGHT_UNITS_PER_LEVEL, lightDirection } from "../terrain/Relief";
import {
  buildTerrainRGBA,
  encodeTerrainTile,
  TerrainColorOverrides,
} from "../utils/ColorUtils";
import {
  createMapQuad,
  createProgram,
  createTexture2D,
  shaderSrc,
} from "../utils/GlUtils";

// ---------------------------------------------------------------------------
// TerrainPass
// ---------------------------------------------------------------------------

export class TerrainPass {
  private program: WebGLProgram;
  private tex: WebGLTexture;
  private vao: WebGLVertexArrayObject;
  private uShadeStrength: WebGLUniformLocation | null;
  private uReliefScale: WebGLUniformLocation | null;
  private uLightDir: WebGLUniformLocation | null;
  /** Hillshade source: RG8 height field + the live mapView settings. */
  private relief: {
    tex: WebGLTexture;
    view: RenderSettings["mapView"];
  } | null = null;
  private mapW: number;
  private mapH: number;
  // Base ocean (deep water) color; reused by applyTerrainRects and rebuilds.
  private terrainColors: TerrainColorOverrides | undefined;
  // Scratch RGBA buffer for rect sub-uploads; grown as needed and reused
  // across applyTerrainRects calls.
  private rgbaScratch = new Uint8Array(0);

  constructor(
    private gl: WebGL2RenderingContext,
    // Regenerates current per-tile terrain bytes (reflecting water-nuke
    // conversions) for the rare full re-bake in setTerrainColors. A provider
    // instead of a retained buffer: terrain bytes are map-sized (8 MB on the
    // giant map).
    private terrainSource: () => Uint8Array,
    terrainBytes: Uint8Array,
    mapW: number,
    mapH: number,
    terrainColors?: TerrainColorOverrides,
  ) {
    this.mapW = mapW;
    this.mapH = mapH;
    this.terrainColors = terrainColors;
    this.program = createProgram(
      gl,
      shaderSrc(terrainVertSrc, { MAP_W: mapW, MAP_H: mapH }),
      shaderSrc(terrainFragSrc, { MAP_W: mapW, MAP_H: mapH }),
      "TerrainPass",
    );
    this.uShadeStrength = gl.getUniformLocation(this.program, "uShadeStrength");
    this.uReliefScale = gl.getUniformLocation(this.program, "uReliefScale");
    this.uLightDir = gl.getUniformLocation(this.program, "uLightDir");
    gl.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, "uTerrain"), 0);
    gl.uniform1i(gl.getUniformLocation(this.program, "uHeightField"), 1);

    this.tex = createTexture2D(gl, {
      width: mapW,
      height: mapH,
      internalFormat: gl.RGBA8,
      format: gl.RGBA,
      type: gl.UNSIGNED_BYTE,
      data: buildTerrainRGBA(terrainBytes, mapW, mapH, terrainColors),
      filter: gl.NEAREST, // pixel-crisp at all zoom levels
    });

    this.vao = createMapQuad(gl, mapW, mapH);
  }

  /**
   * Enable hillshading from an RG8 height field (HeightField.tex). `view` is
   * the live mapView settings slice, read every draw. Null turns it off.
   */
  setRelief(
    tex: WebGLTexture | null,
    view: RenderSettings["mapView"] | null,
  ): void {
    this.relief = tex !== null && view !== null ? { tex, view } : null;
  }

  /**
   * Replace the base terrain colors and re-upload the whole terrain texture.
   * Called when the user changes the terrain colors in graphics settings.
   */
  setTerrainColors(terrainColors?: TerrainColorOverrides): void {
    this.terrainColors = terrainColors;
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
      buildTerrainRGBA(
        this.terrainSource(),
        this.mapW,
        this.mapH,
        terrainColors,
      ),
    );
  }

  /**
   * Update terrain regions in-place (e.g. land→water from a water nuke).
   * Each rect's terrain bytes are stored row-major, concatenated in `bytes`
   * in rect order. One texSubImage2D per rect — a massive bomb changes tens
   * of thousands of tiles, so per-tile 1×1 uploads are too slow. A later full
   * re-upload (setTerrainColors) regenerates from terrainSource, whose
   * backing game map already reflects these conversions.
   */
  applyTerrainRects(rects: readonly TerrainRect[], bytes: Uint8Array): void {
    if (rects.length === 0) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    let offset = 0;
    for (const r of rects) {
      const count = r.w * r.h;
      if (this.rgbaScratch.length < count * 4) {
        this.rgbaScratch = new Uint8Array(count * 4);
      }
      for (let i = 0; i < count; i++) {
        encodeTerrainTile(
          bytes[offset + i],
          this.rgbaScratch,
          i * 4,
          this.terrainColors,
        );
      }
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        r.x,
        r.y,
        r.w,
        r.h,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        this.rgbaScratch,
        0,
      );
      offset += count;
    }
  }

  /** Render the terrain. Call with depth test disabled, no blending. */
  draw(cameraMatrix: Float32Array): void {
    const gl = this.gl;
    gl.useProgram(this.program);

    const relief = this.relief;
    const shade =
      relief !== null && relief.view.hillshade
        ? relief.view.hillshadeStrength
        : 0;
    gl.uniform1f(this.uShadeStrength, shade);
    if (relief !== null && shade > 0) {
      const v = relief.view;
      gl.uniform1f(this.uReliefScale, v.reliefScale / HEIGHT_UNITS_PER_LEVEL);
      const [lx, ly, lz] = lightDirection(
        v.lightAzimuthDeg,
        v.lightAltitudeDeg,
      );
      gl.uniform3f(this.uLightDir, lx, ly, lz);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, relief.tex);
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);

    drawMapSurface(gl, this.vao);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteTexture(this.tex);
    // VAO + buffer leak is acceptable on dispose (context is being destroyed)
  }
}
