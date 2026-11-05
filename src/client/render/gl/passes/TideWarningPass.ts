/**
 * TideWarningPass — during a rising tide warning, a pulsing water tint over
 * every tile the coming wave floods.
 *
 * The tiles go into a map-sized R8UI mask, uploaded once per warning (about
 * every three minutes); the pass draws nothing between warnings. The mask is
 * only allocated the first time a warning arrives, so the mode costs nothing
 * while it is off.
 */

import fragSrc from "../shaders/tide-warning/tide-warning.frag.glsl?raw";
import vertSrc from "../shaders/tide-warning/tide-warning.vert.glsl?raw";
import { drawMapSurface } from "../terrain/MapSurface";
import {
  createMapQuad,
  createProgram,
  createTexture2D,
  shaderSrc,
} from "../utils/GlUtils";

export class TideWarningPass {
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private uMask: WebGLUniformLocation;
  private uTime: WebGLUniformLocation;

  private maskTex: WebGLTexture | null = null;
  private maskData: Uint8Array | null = null;
  /** The tiles set in maskData, so the next upload can clear them. */
  private marked: ArrayLike<number> = [];
  private active = false;
  private startTime = performance.now();

  constructor(
    private gl: WebGL2RenderingContext,
    private mapW: number,
    private mapH: number,
  ) {
    const defines = { MAP_W: mapW, MAP_H: mapH };
    this.program = createProgram(
      gl,
      shaderSrc(vertSrc, defines),
      shaderSrc(fragSrc, defines),
      "TideWarningPass",
    );
    this.uMask = gl.getUniformLocation(this.program, "uMask")!;
    this.uTime = gl.getUniformLocation(this.program, "uTime")!;
    this.vao = createMapQuad(gl, mapW, mapH);
  }

  /** The tiles the coming wave floods; empty to hide the warning. */
  update(tiles: ArrayLike<number>): void {
    this.active = tiles.length > 0;
    if (!this.active && this.maskData === null) return;
    const gl = this.gl;
    if (this.maskData === null || this.maskTex === null) {
      this.maskData = new Uint8Array(this.mapW * this.mapH);
      this.maskTex = createTexture2D(gl, {
        width: this.mapW,
        height: this.mapH,
        internalFormat: gl.R8UI,
        format: gl.RED_INTEGER,
        type: gl.UNSIGNED_BYTE,
        data: this.maskData,
        filter: gl.NEAREST,
      });
    }
    const mask = this.maskData;
    for (let i = 0; i < this.marked.length; i++) mask[this.marked[i]] = 0;
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      if (t >= 0 && t < mask.length) mask[t] = 1;
    }
    this.marked = tiles;
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      this.mapW,
      this.mapH,
      gl.RED_INTEGER,
      gl.UNSIGNED_BYTE,
      mask,
    );
  }

  draw(cameraMatrix: Float32Array): void {
    if (!this.active || this.maskTex === null) return;
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.uniform1f(this.uTime, (performance.now() - this.startTime) / 1000);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.uniform1i(this.uMask, 0);
    // Draped on the 3D terrain like the territory overlay.
    drawMapSurface(gl, this.vao);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    if (this.maskTex !== null) gl.deleteTexture(this.maskTex);
    gl.deleteVertexArray(this.vao);
  }
}
