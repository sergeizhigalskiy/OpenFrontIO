/**
 * RuinsPass — a stone ruins badge on every unclaimed ruin (world features).
 *
 * Everyone sees every ruin, but not what it holds. The badge matches the
 * resource sites' (a dark disc with a light emblem and a grey ring), and is
 * sized like them, so it reads on any terrain at every zoom. One draw call
 * per ruin; a map has at most a few dozen, and they disappear as they are
 * claimed.
 */

import { createProgram } from "../utils/GlUtils";
import { resourceSiteRadius } from "./ResourceSitePass";

import fragSrc from "../shaders/ruins/ruins.frag.glsl?raw";
import vertSrc from "../shaders/ruins/ruins.vert.glsl?raw";

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

  draw(cameraMatrix: Float32Array, zoom: number): void {
    if (this.ruins.length === 0) return;
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.uniform1f(this.uRadius, resourceSiteRadius(zoom));
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
