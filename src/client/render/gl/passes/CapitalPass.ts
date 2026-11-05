/**
 * CapitalPass — a star on every player's capital (conventional war only).
 *
 * Everyone sees every capital: it is public, like the territory around it.
 * The star is gold, rimmed with its owner's territory color, so it reads on
 * any terrain. One draw call per capital; there are few (tribes have none).
 */

import { createProgram } from "../utils/GlUtils";

import fragSrc from "../shaders/capital/capital.frag.glsl?raw";
import vertSrc from "../shaders/capital/capital.vert.glsl?raw";

/** Star radius in tiles. */
const CAPITAL_STAR_RADIUS = 5;

/** A capital to draw: its tile and its owner's territory color (0-1). */
export interface CapitalMarker {
  x: number;
  y: number;
  r: number;
  g: number;
  b: number;
}

export class CapitalPass {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private quadBuf: WebGLBuffer;

  private uCenter: WebGLUniformLocation;
  private uRadius: WebGLUniformLocation;
  private uColor: WebGLUniformLocation;

  private capitals: CapitalMarker[] = [];

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = createProgram(gl, vertSrc, fragSrc, "CapitalPass");

    this.uCenter = gl.getUniformLocation(this.program, "uCenter")!;
    this.uRadius = gl.getUniformLocation(this.program, "uRadius")!;
    this.uColor = gl.getUniformLocation(this.program, "uColor")!;

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

  update(capitals: CapitalMarker[]): void {
    this.capitals = capitals;
  }

  draw(cameraMatrix: Float32Array): void {
    if (this.capitals.length === 0) return;
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.uniform1f(this.uRadius, CAPITAL_STAR_RADIUS);
    gl.bindVertexArray(this.vao);
    for (const c of this.capitals) {
      gl.uniform2f(this.uCenter, c.x, c.y);
      gl.uniform3f(this.uColor, c.r, c.g, c.b);
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
