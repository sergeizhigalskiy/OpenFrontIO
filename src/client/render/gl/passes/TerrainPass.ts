/**
 * TerrainPass — draws the map surface: land coloured by elevation, water
 * shaded by depth with a shoreline and a gently moving surface, the map's
 * terrain features (forest canopy, rivers, fords), and a hillshade.
 *
 * Tile kinds come from the raw terrain bytes (the shared R8UI texture), so
 * coasts and walls stay tile-crisp. Smooth quantities — water depth, coast
 * and wall distance, palette elevation — come from the SurfaceField, built
 * once at load and patched when terrain floods. Colours are uniforms derived
 * from settings.terrain, so changing them needs no re-bake.
 *
 * With hillshade on (setRelief), land is lit from the palette elevation:
 * normals from neighbouring heights, one light (the mapView azimuth and
 * altitude), plus a soft bevel along coasts and contact shadows.
 */

import type { TerrainRect } from "../../types";
import type { RenderSettings } from "../RenderSettings";
import terrainFragSrc from "../shaders/terrain/terrain.frag.glsl?raw";
import terrainVertSrc from "../shaders/terrain/terrain.vert.glsl?raw";
import { drawMapSurface } from "../terrain/MapSurface";
import { lightDirection } from "../terrain/Relief";
import { packTerrainFeatures } from "../terrain/SurfaceData";
import { SurfaceField } from "../terrain/SurfaceField";
import { createTerrainNoiseTexture } from "../terrain/TerrainNoise";
import {
  resolveTerrainPalette,
  TerrainColorOverrides,
  TerrainPalette,
} from "../utils/ColorUtils";
import {
  createMapQuad,
  createProgram,
  createTexture2D,
  shaderSrc,
} from "../utils/GlUtils";

/** uTime wraps after this many seconds (TIME_PERIOD in terrain.frag.glsl). */
const TIME_PERIOD_S = 600;

const PALETTE_UNIFORMS = [
  ["uBackground", "background"],
  ["uOcean", "ocean"],
  ["uSand", "sand"],
  ["uPlains", "plains"],
  ["uHighland", "highland"],
  ["uMountain", "mountain"],
] as const;

export class TerrainPass {
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private surface: SurfaceField;
  private noiseTex: WebGLTexture;
  private featureTex: WebGLTexture | null = null;
  private palette: TerrainPalette;
  private paletteDirty = true;
  private uShadeStrength: WebGLUniformLocation | null;
  private uReliefScale: WebGLUniformLocation | null;
  private uLightDir: WebGLUniformLocation | null;
  private uTime: WebGLUniformLocation | null;
  private uHasFeatures: WebGLUniformLocation | null;
  private uPalette: (WebGLUniformLocation | null)[];
  /** Live mapView settings (hillshade, light); null = relief off. */
  private relief: RenderSettings["mapView"] | null = null;
  private readonly startTime = performance.now();

  constructor(
    private gl: WebGL2RenderingContext,
    // Regenerates the current per-tile terrain bytes (reflecting floods) for
    // surface-field patches. A provider instead of a retained buffer:
    // terrain bytes are map-sized (8 MB on the giant map).
    private terrainSource: () => Uint8Array,
    terrainBytes: Uint8Array,
    /** Terrain-bytes R8UI texture (shared, kept current by the renderer). */
    private terrainBytesTex: WebGLTexture,
    private mapW: number,
    private mapH: number,
    terrainColors?: TerrainColorOverrides,
  ) {
    this.palette = resolveTerrainPalette(terrainColors);
    const defines = { MAP_W: mapW, MAP_H: mapH };
    this.program = createProgram(
      gl,
      shaderSrc(terrainVertSrc, defines),
      shaderSrc(terrainFragSrc, defines),
      "TerrainPass",
    );
    const p = this.program;
    this.uShadeStrength = gl.getUniformLocation(p, "uShadeStrength");
    this.uReliefScale = gl.getUniformLocation(p, "uReliefScale");
    this.uLightDir = gl.getUniformLocation(p, "uLightDir");
    this.uTime = gl.getUniformLocation(p, "uTime");
    this.uHasFeatures = gl.getUniformLocation(p, "uHasFeatures");
    this.uPalette = PALETTE_UNIFORMS.map(([name]) =>
      gl.getUniformLocation(p, name),
    );
    gl.useProgram(p);
    gl.uniform1i(gl.getUniformLocation(p, "uTerrainBytes"), 0);
    gl.uniform1i(gl.getUniformLocation(p, "uSurface"), 1);
    gl.uniform1i(gl.getUniformLocation(p, "uFeatures"), 2);
    gl.uniform1i(gl.getUniformLocation(p, "uNoise"), 3);

    this.surface = new SurfaceField(gl, terrainBytes, mapW, mapH);
    this.noiseTex = createTerrainNoiseTexture(gl);
    this.vao = createMapQuad(gl, mapW, mapH);
  }

  /**
   * Hillshade from the live mapView settings slice (read every draw, so the
   * toggle and light take effect at once). Null turns relief off.
   */
  setRelief(view: RenderSettings["mapView"] | null): void {
    this.relief = view;
  }

  /** Replace the terrain colours (graphics settings). No re-bake needed. */
  setTerrainColors(terrainColors?: TerrainColorOverrides): void {
    this.palette = resolveTerrainPalette(terrainColors);
    this.paletteDirty = true;
  }

  /**
   * The map's terrain features, one TerrainFeature per tile (0 none,
   * 1 forest, 2 river, 3 ford), or null for none. Static per map.
   */
  setFeatures(features: Uint8Array | null): void {
    const gl = this.gl;
    if (this.featureTex !== null) gl.deleteTexture(this.featureTex);
    this.featureTex = null;
    if (features === null) return;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.featureTex = createTexture2D(gl, {
      width: this.mapW,
      height: this.mapH,
      internalFormat: gl.R8UI,
      format: gl.RED_INTEGER,
      type: gl.UNSIGNED_BYTE,
      data: packTerrainFeatures(features, this.mapW, this.mapH),
      filter: gl.NEAREST,
    });
  }

  /**
   * Terrain changed inside these rects (land → water from a water nuke or a
   * rising tide). The shared terrain-bytes texture is updated by the
   * renderer; this patches the surface field around the flooded tiles.
   */
  applyTerrainRects(rects: readonly TerrainRect[]): void {
    if (rects.length === 0) return;
    this.surface.applyTerrainRects(rects, this.terrainSource());
  }

  /** Render the terrain. Call with depth test disabled, no blending. */
  draw(_cameraMatrix: Float32Array): void {
    const gl = this.gl;
    gl.useProgram(this.program);

    if (this.paletteDirty) {
      this.paletteDirty = false;
      PALETTE_UNIFORMS.forEach(([, key], i) => {
        const [r, g, b] = this.palette[key];
        gl.uniform3f(this.uPalette[i], r / 255, g / 255, b / 255);
      });
    }

    const v = this.relief;
    const shade = v !== null && v.hillshade ? v.hillshadeStrength : 0;
    gl.uniform1f(this.uShadeStrength, shade);
    if (v !== null && shade > 0) {
      gl.uniform1f(this.uReliefScale, v.reliefScale);
      const [lx, ly, lz] = lightDirection(
        v.lightAzimuthDeg,
        v.lightAltitudeDeg,
      );
      gl.uniform3f(this.uLightDir, lx, ly, lz);
    }
    const seconds = (performance.now() - this.startTime) / 1000;
    gl.uniform1f(this.uTime, seconds % TIME_PERIOD_S);
    gl.uniform1i(this.uHasFeatures, this.featureTex !== null ? 1 : 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.terrainBytesTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.surface.tex);
    gl.activeTexture(gl.TEXTURE2);
    // Without features the shader never reads unit 2; bind the terrain bytes
    // so the usampler still has an integer texture behind it.
    gl.bindTexture(gl.TEXTURE_2D, this.featureTex ?? this.terrainBytesTex);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.noiseTex);
    gl.activeTexture(gl.TEXTURE0);

    drawMapSurface(gl, this.vao);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    this.surface.dispose();
    gl.deleteTexture(this.noiseTex);
    if (this.featureTex !== null) gl.deleteTexture(this.featureTex);
    gl.deleteVertexArray(this.vao);
  }
}
