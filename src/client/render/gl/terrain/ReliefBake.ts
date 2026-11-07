/**
 * ReliefBake — soft sun shadows and ambient occlusion cast from the relief
 * heights, baked on the GPU into three map-sized RGBA8 textures:
 *
 *   shadowTexA  RGBA: sun visibility toward azimuths 0, 45, 90, 135
 *   shadowTexB  RGBA: sun visibility toward azimuths 180, 225, 270, 315
 *   reliefTex   R: sky openness (ambient occlusion)
 *
 * All LINEAR-filtered, so a fetch gives a soft value between tiles. The
 * shader blends the two azimuths either side of the sun (SceneLight.ts), so
 * the camera orbits freely without a re-bake. The bake re-runs only when
 * the heights change (a flood: just the changed area plus the reach of a
 * shadow) or the height scale or sun altitude is tuned (the whole map).
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

/** How far a shadow can fall, tiles (MAX_REACH in the shader). */
const SHADOW_REACH = 72;
const DEG = Math.PI / 180;

export interface BakeParams {
  /** World tiles of height per elevation level (mapView.heightScale). */
  heightScale: number;
  /** Sun altitude above the horizon, degrees. */
  sunAltitudeDeg: number;
}

export class ReliefBake {
  readonly shadowTexA: WebGLTexture;
  readonly shadowTexB: WebGLTexture;
  readonly reliefTex: WebGLTexture;
  private fbo: WebGLFramebuffer;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private uHeightTiles: WebGLUniformLocation | null;
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
    this.shadowTexA = target();
    this.shadowTexB = target();
    this.reliefTex = target();
    this.fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.shadowTexA,
      0,
    );
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT1,
      gl.TEXTURE_2D,
      this.shadowTexB,
      0,
    );
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT2,
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
    const key = `${params.heightScale}|${params.sunAltitudeDeg}`;
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
    gl.drawBuffers([
      gl.COLOR_ATTACHMENT0,
      gl.COLOR_ATTACHMENT1,
      gl.COLOR_ATTACHMENT2,
    ]);
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
    gl.deleteTexture(this.shadowTexA);
    gl.deleteTexture(this.shadowTexB);
    gl.deleteTexture(this.reliefTex);
    gl.deleteFramebuffer(this.fbo);
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
  }
}
