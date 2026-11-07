/**
 * ReliefBake — soft sun shadows and ambient occlusion cast from the relief
 * heights, baked on the GPU into two map-sized RGBA8 textures:
 *
 *   shadowTex  RGBA: sun visibility toward the four isometric sun azimuths
 *              (SceneLight.ts ISO_SUN_AZIMUTHS), one per rotation
 *   reliefTex  R: sky openness (ambient occlusion), G: sun visibility toward
 *              the other views' azimuth
 *
 * Both LINEAR-filtered, so a fetch gives a soft value between tiles. The sun
 * is fixed per channel, so the bake only re-runs when the heights change
 * (a flood: just the changed area plus the reach of a shadow) or when the
 * height scale or the sun moves (the whole map).
 */

import type { TerrainRect } from "../../types";
import bakeFragSrc from "../shaders/relief/relief-bake.frag.glsl?raw";
import fullscreenVertSrc from "../shaders/shared/fullscreen.vert.glsl?raw";
import {
  createFullscreenQuad,
  createProgram,
  createTexture2D,
} from "../utils/GlUtils";
import { HEIGHT_UNITS_PER_LEVEL } from "./Relief";
import { ISO_SUN_AZIMUTHS } from "./SceneLight";

/** How far a shadow can fall, tiles (MAX_REACH in the shader). */
const SHADOW_REACH = 72;
const DEG = Math.PI / 180;

export interface BakeParams {
  /** World tiles of height per elevation level (mapView.heightScale). */
  heightScale: number;
  /** Sun altitude above the horizon, degrees. */
  sunAltitudeDeg: number;
  /** The non-isometric views' sun azimuth, degrees. */
  flatAzimuthDeg: number;
}

export class ReliefBake {
  readonly shadowTex: WebGLTexture;
  readonly reliefTex: WebGLTexture;
  private fbo: WebGLFramebuffer;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private uHeightTiles: WebGLUniformLocation | null;
  private uSunAz: WebGLUniformLocation | null;
  private uSunAzFlat: WebGLUniformLocation | null;
  private uSunAlt: WebGLUniformLocation | null;
  private bakedKey = "";

  constructor(
    private gl: WebGL2RenderingContext,
    private mapW: number,
    private mapH: number,
  ) {
    const target = () =>
      createTexture2D(gl, {
        width: mapW,
        height: mapH,
        internalFormat: gl.RGBA8,
        format: gl.RGBA,
        type: gl.UNSIGNED_BYTE,
        data: null,
        filter: gl.LINEAR,
      });
    this.shadowTex = target();
    this.reliefTex = target();
    this.fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.shadowTex,
      0,
    );
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT1,
      gl.TEXTURE_2D,
      this.reliefTex,
      0,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.program = createProgram(
      gl,
      fullscreenVertSrc,
      bakeFragSrc,
      "ReliefBake",
    );
    const p = this.program;
    this.uHeightTiles = gl.getUniformLocation(p, "uHeightTiles");
    this.uSunAz = gl.getUniformLocation(p, "uSunAz");
    this.uSunAzFlat = gl.getUniformLocation(p, "uSunAzFlat");
    this.uSunAlt = gl.getUniformLocation(p, "uSunAlt");
    gl.useProgram(p);
    gl.uniform1i(gl.getUniformLocation(p, "uHeight"), 0);
    gl.uniform2f(gl.getUniformLocation(p, "uMapSize"), mapW, mapH);
    this.vao = createFullscreenQuad(gl);
  }

  /**
   * Bake if the parameters changed since the last bake (the whole map), or
   * re-bake `dirty` (heights changed there). Leaves the default framebuffer
   * bound; the caller sets its viewport afterwards.
   */
  update(
    heightTex: WebGLTexture,
    params: BakeParams,
    dirty: TerrainRect | null,
  ): void {
    const key = `${params.heightScale}|${params.sunAltitudeDeg}|${params.flatAzimuthDeg}`;
    if (key !== this.bakedKey) {
      this.bakedKey = key;
      this.bake(heightTex, params, null);
    } else if (dirty !== null) {
      this.bake(heightTex, params, dirty);
    }
  }

  private bake(
    heightTex: WebGLTexture,
    params: BakeParams,
    rect: TerrainRect | null,
  ): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.viewport(0, 0, this.mapW, this.mapH);
    gl.disable(gl.BLEND);
    if (rect !== null) {
      // Shadows reach this far from the changed heights.
      const x0 = Math.max(0, rect.x - SHADOW_REACH);
      const y0 = Math.max(0, rect.y - SHADOW_REACH);
      const x1 = Math.min(this.mapW, rect.x + rect.w + SHADOW_REACH);
      const y1 = Math.min(this.mapH, rect.y + rect.h + SHADOW_REACH);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(x0, y0, x1 - x0, y1 - y0);
    }
    gl.useProgram(this.program);
    gl.uniform1f(
      this.uHeightTiles,
      (255 / HEIGHT_UNITS_PER_LEVEL) * params.heightScale,
    );
    gl.uniform4f(
      this.uSunAz,
      ISO_SUN_AZIMUTHS[0] * DEG,
      ISO_SUN_AZIMUTHS[1] * DEG,
      ISO_SUN_AZIMUTHS[2] * DEG,
      ISO_SUN_AZIMUTHS[3] * DEG,
    );
    gl.uniform1f(this.uSunAzFlat, params.flatAzimuthDeg * DEG);
    gl.uniform1f(this.uSunAlt, params.sunAltitudeDeg * DEG);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, heightTex);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    gl.disable(gl.SCISSOR_TEST);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteTexture(this.shadowTex);
    gl.deleteTexture(this.reliefTex);
    gl.deleteFramebuffer(this.fbo);
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
  }
}
