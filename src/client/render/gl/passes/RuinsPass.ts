/**
 * RuinsPass — a stone ruins icon on every unclaimed ruin (world features).
 *
 * Everyone sees every ruin, but not what it holds. The icon is light stone
 * with a dark outline, so it reads on any terrain. One draw call per ruin;
 * a map has at most a few dozen, and they disappear as they are claimed.
 */

import { createProgram } from "../utils/GlUtils";

import fragSrc from "../shaders/ruins/ruins.frag.glsl?raw";
import vertSrc from "../shaders/ruins/ruins.vert.glsl?raw";

/** Icon radius in tiles. */
const RUINS_ICON_RADIUS = 4;

/** A ruin to draw: its tile. */
export interface RuinMarker {
  x: number;
  y: number;
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

  draw(cameraMatrix: Float32Array): void {
    if (this.ruins.length === 0) return;
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.uniform1f(this.uRadius, RUINS_ICON_RADIUS);
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
