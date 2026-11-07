/**
 * TerrainPass — draws the map surface: textured, lit land in biomes (grass,
 * steppe, desert, dirt, rock, tundra, snow), water shaded by depth with
 * waves, fresnel, sun glint and shore foam, a soft coastline, and the map's
 * terrain features (forest canopy, rivers, fords).
 *
 * Tile kinds and features come from the raw terrain bytes and the feature
 * texture. Smooth quantities come from per-tile fields sampled LINEAR:
 * the SurfaceField (water depth, coast and wall distance, palette
 * elevation) and the ClimateField (signed coast distance, moisture, cold,
 * broad variation), both built at load and patched when terrain floods.
 * Colours are uniforms derived from settings.terrain, so changing them needs
 * no re-bake.
 *
 * Light comes from the renderer each draw (TerrainLighting): the sun for
 * the current view (SceneLight.ts), the relief bake's shadow and openness
 * textures (ReliefBake.ts), and the relief heights through the camera
 * include. The ground detail is a procedural texture array
 * (DetailTextures.ts). setQuality picks the shader variant (low, medium,
 * high).
 */

import type { TerrainRect } from "../../types";
import type { TerrainQuality } from "../GraphicsOverrides";
import terrainFragSrc from "../shaders/terrain/terrain.frag.glsl?raw";
import terrainVertSrc from "../shaders/terrain/terrain.vert.glsl?raw";
import { ClimateField } from "../terrain/ClimateField";
import { createDetailTextures } from "../terrain/DetailTextures";
import { drawMapSurface } from "../terrain/MapSurface";
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

/** Most world-feature sites drawn into the ground (MAX_SITES). */
export const MAX_TERRAIN_SITES = 32;

/** A world-feature site drawn into the ground. */
export interface TerrainSite {
  x: number;
  y: number;
  kind: "ruin" | "volcano";
  /** A volcano about to erupt: its crater and flanks glow. */
  rumbling?: boolean;
}

/** QUALITY define per terrain quality setting. */
export const QUALITY_LEVEL: Record<TerrainQuality, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

/** What the terrain is lit with this frame (filled by the renderer). */
export interface TerrainLighting {
  /** Relief lighting strength: 0 = flat (hillshade off), 1 = full. */
  shadeStrength: number;
  /** World tiles of height per unit of the height map (camera include). */
  heightTiles: number;
  /** Unit vector toward the sun. */
  lightDir: readonly [number, number, number];
  /** Weights of the shadow textures' channels (SceneLight.ts). */
  shadowWeightsA: readonly [number, number, number, number];
  shadowWeightsB: readonly [number, number, number, number];
  /** The relief bake's textures; null reads as open ground in full sun. */
  shadowTexA: WebGLTexture | null;
  shadowTexB: WebGLTexture | null;
  reliefTex: WebGLTexture | null;
  /** Winter snow over the snow band, 0-1. */
  winter: number;
  /** Tile rows of the snow band, from the top of the map. */
  snowRows: number;
}

/** Light for a flat, unshaded surface (no relief bake). */
export const FLAT_LIGHTING: TerrainLighting = {
  shadeStrength: 0,
  heightTiles: 0,
  lightDir: [0, 0, 1],
  shadowWeightsA: [1, 0, 0, 0],
  shadowWeightsB: [0, 0, 0, 0],
  shadowTexA: null,
  shadowTexB: null,
  reliefTex: null,
  winter: 0,
  snowRows: 0,
};

interface TerrainUniforms {
  shadeStrength: WebGLUniformLocation | null;
  heightTiles: WebGLUniformLocation | null;
  lightDir: WebGLUniformLocation | null;
  shadowWA: WebGLUniformLocation | null;
  shadowWB: WebGLUniformLocation | null;
  winter: WebGLUniformLocation | null;
  snowRows: WebGLUniformLocation | null;
  time: WebGLUniformLocation | null;
  hasFeatures: WebGLUniformLocation | null;
  sites: WebGLUniformLocation | null;
  siteCount: WebGLUniformLocation | null;
  palette: (WebGLUniformLocation | null)[];
}

export class TerrainPass {
  private program!: WebGLProgram;
  private u!: TerrainUniforms;
  private vao: WebGLVertexArrayObject;
  private surface: SurfaceField;
  private climate: ClimateField;
  private noiseTex: WebGLTexture;
  private detailTex: WebGLTexture;
  private featureTex: WebGLTexture | null = null;
  /** 1×1 white: full sun and open sky, when there is no relief bake. */
  private whiteTex: WebGLTexture;
  private palette: TerrainPalette;
  private paletteDirty = true;
  private quality: TerrainQuality;
  private readonly startTime = performance.now();
  /** Site uniforms (x, y, kind, rumbling) and how many are set. */
  private siteData = new Float32Array(MAX_TERRAIN_SITES * 4);
  private siteCount = 0;

  constructor(
    private gl: WebGL2RenderingContext,
    // Regenerates the current per-tile terrain bytes (reflecting floods) for
    // field patches. A provider instead of a retained buffer: terrain bytes
    // are map-sized (8 MB on the giant map).
    private terrainSource: () => Uint8Array,
    terrainBytes: Uint8Array,
    /** Terrain-bytes R8UI texture (shared, kept current by the renderer). */
    private terrainBytesTex: WebGLTexture,
    private mapW: number,
    private mapH: number,
    terrainColors?: TerrainColorOverrides,
    quality: TerrainQuality = "high",
  ) {
    this.palette = resolveTerrainPalette(terrainColors);
    this.quality = quality;
    this.buildProgram();
    this.surface = new SurfaceField(gl, terrainBytes, mapW, mapH);
    this.climate = new ClimateField(gl, terrainBytes, mapW, mapH);
    this.noiseTex = createTerrainNoiseTexture(gl);
    this.detailTex = createDetailTextures(gl);
    this.whiteTex = createTexture2D(gl, {
      width: 1,
      height: 1,
      internalFormat: gl.RGBA8,
      format: gl.RGBA,
      type: gl.UNSIGNED_BYTE,
      data: new Uint8Array([255, 255, 255, 255]),
    });
    this.vao = createMapQuad(gl, mapW, mapH);
  }

  private buildProgram(): void {
    const gl = this.gl;
    const defines = {
      MAP_W: this.mapW,
      MAP_H: this.mapH,
      QUALITY: QUALITY_LEVEL[this.quality],
      MAX_SITES: MAX_TERRAIN_SITES,
    };
    const p = createProgram(
      gl,
      shaderSrc(terrainVertSrc, defines),
      shaderSrc(terrainFragSrc, defines),
      "TerrainPass",
    );
    const at = (name: string) => gl.getUniformLocation(p, name);
    this.u = {
      shadeStrength: at("uShadeStrength"),
      heightTiles: at("uHeightTiles"),
      lightDir: at("uLightDir"),
      shadowWA: at("uShadowWA"),
      shadowWB: at("uShadowWB"),
      winter: at("uWinter"),
      snowRows: at("uSnowRows"),
      time: at("uTime"),
      hasFeatures: at("uHasFeatures"),
      sites: at("uSites"),
      siteCount: at("uSiteCount"),
      palette: PALETTE_UNIFORMS.map(([name]) => at(name)),
    };
    gl.useProgram(p);
    gl.uniform1i(at("uTerrainBytes"), 0);
    gl.uniform1i(at("uSurface"), 1);
    gl.uniform1i(at("uFeatures"), 2);
    gl.uniform1i(at("uNoise"), 3);
    gl.uniform1i(at("uClimate"), 4);
    gl.uniform1i(at("uShadowA"), 5);
    gl.uniform1i(at("uShadowB"), 8);
    gl.uniform1i(at("uRelief"), 6);
    gl.uniform1i(at("uDetail"), 7);
    this.program = p;
    this.paletteDirty = true;
  }

  /** Switch the shader variant (Low, Medium, High). */
  setQuality(quality: TerrainQuality): void {
    if (quality === this.quality) return;
    this.quality = quality;
    this.gl.deleteProgram(this.program);
    this.buildProgram();
  }

  /**
   * The world-feature sites to draw into the ground (ruins, volcanoes); up
   * to MAX_TERRAIN_SITES, volcanoes first.
   */
  setSites(sites: readonly TerrainSite[]): void {
    const ordered = [...sites].sort(
      (a, b) => (a.kind === "volcano" ? 0 : 1) - (b.kind === "volcano" ? 0 : 1),
    );
    const n = Math.min(MAX_TERRAIN_SITES, ordered.length);
    for (let i = 0; i < n; i++) {
      const s = ordered[i];
      this.siteData[i * 4] = s.x;
      this.siteData[i * 4 + 1] = s.y;
      this.siteData[i * 4 + 2] = s.kind === "volcano" ? 1 : 0;
      this.siteData[i * 4 + 3] = s.rumbling === true ? 1 : 0;
    }
    this.siteCount = n;
  }

  /** The climate field (signed coast distance etc.), for overlay passes. */
  get climateTex(): WebGLTexture {
    return this.climate.tex;
  }

  /** Replace the terrain colours (graphics settings). No re-bake needed. */
  setTerrainColors(terrainColors?: TerrainColorOverrides): void {
    this.palette = resolveTerrainPalette(terrainColors);
    this.paletteDirty = true;
  }

  /**
   * The map's terrain features, one TerrainFeature per tile (0 none,
   * 1 forest, 2 river, 3 ford), or null for none. Static per map. Rivers
   * and forests also wet the ground around them (the climate field).
   */
  setFeatures(features: Uint8Array | null): void {
    const gl = this.gl;
    if (this.featureTex !== null) gl.deleteTexture(this.featureTex);
    this.featureTex = null;
    this.climate.setFeatures(this.terrainSource(), features);
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
   * renderer; this patches the surface and climate fields around the
   * flooded tiles.
   */
  applyTerrainRects(rects: readonly TerrainRect[]): void {
    if (rects.length === 0) return;
    const terrain = this.terrainSource();
    this.surface.applyTerrainRects(rects, terrain);
    this.climate.applyTerrainRects(rects, terrain);
  }

  /** Render the terrain. Call with depth test disabled, no blending. */
  draw(_cameraMatrix: Float32Array, light: TerrainLighting): void {
    const gl = this.gl;
    const u = this.u;
    gl.useProgram(this.program);

    if (this.paletteDirty) {
      this.paletteDirty = false;
      PALETTE_UNIFORMS.forEach(([, key], i) => {
        const [r, g, b] = this.palette[key];
        gl.uniform3f(u.palette[i], r / 255, g / 255, b / 255);
      });
    }

    gl.uniform1f(u.shadeStrength, light.shadeStrength);
    gl.uniform1f(u.heightTiles, light.heightTiles);
    const [lx, ly, lz] = light.lightDir;
    gl.uniform3f(u.lightDir, lx, ly, lz);
    const [a0, a1, a2, a3] = light.shadowWeightsA;
    gl.uniform4f(u.shadowWA, a0, a1, a2, a3);
    const [b0, b1, b2, b3] = light.shadowWeightsB;
    gl.uniform4f(u.shadowWB, b0, b1, b2, b3);
    gl.uniform1f(u.winter, light.winter);
    gl.uniform1f(u.snowRows, light.snowRows);
    const seconds = (performance.now() - this.startTime) / 1000;
    gl.uniform1f(u.time, seconds % TIME_PERIOD_S);
    gl.uniform1i(u.hasFeatures, this.featureTex !== null ? 1 : 0);
    gl.uniform1i(u.siteCount, this.siteCount);
    if (this.siteCount > 0) gl.uniform4fv(u.sites, this.siteData);

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
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.climate.tex);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, light.shadowTexA ?? this.whiteTex);
    gl.activeTexture(gl.TEXTURE8);
    gl.bindTexture(gl.TEXTURE_2D, light.shadowTexB ?? this.whiteTex);
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, light.reliefTex ?? this.whiteTex);
    gl.activeTexture(gl.TEXTURE7);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.detailTex);
    gl.activeTexture(gl.TEXTURE0);

    drawMapSurface(gl, this.vao);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    this.surface.dispose();
    this.climate.dispose();
    gl.deleteTexture(this.noiseTex);
    gl.deleteTexture(this.detailTex);
    gl.deleteTexture(this.whiteTex);
    if (this.featureTex !== null) gl.deleteTexture(this.featureTex);
    gl.deleteVertexArray(this.vao);
  }
}
