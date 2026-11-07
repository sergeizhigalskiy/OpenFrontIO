/**
 * RuinsPass — a stone ruins badge on every unclaimed ruin (world features).
 *
 * Everyone sees every ruin, but not what it holds. The badge (a dark disc
 * with a light emblem and a grey ring) keeps a readable size on screen at
 * every zoom: its world radius grows when zoomed out and shrinks when zoomed
 * in, within MIN/MAX_SCREEN_RADIUS_PX, so it reads on any terrain. One draw
 * call per ruin; a map has at most a few dozen, and they disappear as they
 * are claimed.
 */

import { createProgram } from "../utils/GlUtils";

import fragSrc from "../shaders/ruins/ruins.frag.glsl?raw";
import vertSrc from "../shaders/ruins/ruins.vert.glsl?raw";

/** Badge radius in tiles at medium zoom. */
const RUIN_RADIUS_TILES = 4;
/** Screen radius bounds (canvas pixels), so it reads at every zoom. */
const MIN_SCREEN_RADIUS_PX = 7;
const MAX_SCREEN_RADIUS_PX = 22;

/** A ruin to draw: its tile. */
export interface RuinMarker {
  x: number;
  y: number;
}

/** The badge's world radius at `zoom` (canvas pixels per tile). */
export function ruinBadgeRadius(zoom: number): number {
  const z = Math.max(zoom, 1e-6);
  return Math.max(
    MIN_SCREEN_RADIUS_PX / z,
    Math.min(RUIN_RADIUS_TILES, MAX_SCREEN_RADIUS_PX / z),
  );
}

export class RuinsPass {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private quadBuf: WebGLBuffer;

  private uCenter: WebGLUniformLocation;
  private uRadius: WebGLUniformLocation;

  private ruins: RuinMarker[] = [];

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = createProgram(gl, vertSrc, fragSrc, "RuinsPass");

    this.uCenter = gl.getUniformLocation(this.program, "uCenter")!;
    this.uRadius = gl.getUniformLocation(this.program, "uRadius")!;

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  update(ruins: RuinMarker[]): void {
    this.ruins = ruins;
  }

  draw(cameraMatrix: Float32Array, zoom: number): void {
    if (this.ruins.length === 0) return;
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.uniform1f(this.uRadius, ruinBadgeRadius(zoom));
    gl.bindVertexArray(this.vao);
    for (const r of this.ruins) {
      gl.uniform2f(this.uCenter, r.x, r.y);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteBuffer(this.quadBuf);
    gl.deleteVertexArray(this.vao);
  }
}
