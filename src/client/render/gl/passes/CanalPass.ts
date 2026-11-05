/**
 * CanalPass — canals being dug (UnitType.Canal), for every player: a
 * two-tile-wide strip between the dig's two ends, filling with water from
 * one end as the construction time runs, rimmed with the builder's color.
 * Also the build preview's ghost path, fainter. One draw call per dig;
 * there are few.
 */

import { createProgram } from "../utils/GlUtils";

import fragSrc from "../shaders/canal/canal.frag.glsl?raw";
import vertSrc from "../shaders/canal/canal.vert.glsl?raw";
import { createDrapedQuad, DrapedQuad } from "../terrain/DrapedQuad";

/**
 * A dig to draw: its first and last tile, which way its second row sits
 * (0,1 or 1,0, see engine-lib/game/Canal.ts), the builder's color (0-1) and
 * how far along it is (0-1).
 */
export interface CanalMarker {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  offsetX: number;
  offsetY: number;
  r: number;
  g: number;
  b: number;
  progress: number;
}

export class CanalPass {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  // A draped grid, so the dig follows the 3D terrain across the neck.
  private quad: DrapedQuad;

  private uStart: WebGLUniformLocation;
  private uEnd: WebGLUniformLocation;
  private uHalfWidth: WebGLUniformLocation;
  private uOwner: WebGLUniformLocation;
  private uProgress: WebGLUniformLocation;
  private uAlpha: WebGLUniformLocation;

  private canals: CanalMarker[] = [];
  private ghost: CanalMarker | null = null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = createProgram(gl, vertSrc, fragSrc, "CanalPass");

    this.uStart = gl.getUniformLocation(this.program, "uStart")!;
    this.uEnd = gl.getUniformLocation(this.program, "uEnd")!;
    this.uHalfWidth = gl.getUniformLocation(this.program, "uHalfWidth")!;
    this.uOwner = gl.getUniformLocation(this.program, "uOwner")!;
    this.uProgress = gl.getUniformLocation(this.program, "uProgress")!;
    this.uAlpha = gl.getUniformLocation(this.program, "uAlpha")!;

    this.quad = createDrapedQuad(gl);
  }

  update(canals: CanalMarker[]): void {
    this.canals = canals;
  }

  /** The build preview's path under the cursor, or null. */
  updateGhost(ghost: CanalMarker | null): void {
    this.ghost = ghost;
  }

  draw(cameraMatrix: Float32Array): void {
    if (this.canals.length === 0 && this.ghost === null) return;
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.uniform1f(this.uHalfWidth, 1);
    gl.bindVertexArray(this.quad.vao);
    gl.uniform1f(this.uAlpha, 1);
    for (const c of this.canals) this.drawOne(c);
    if (this.ghost !== null) {
      gl.uniform1f(this.uAlpha, 0.7);
      this.drawOne(this.ghost);
    }
    gl.bindVertexArray(null);
  }

  private drawOne(c: CanalMarker): void {
    const gl = this.gl;
    // Tile centers, moved half a tile toward the second row so the strip
    // covers both rows.
    const ox = 0.5 + c.offsetX * 0.5;
    const oy = 0.5 + c.offsetY * 0.5;
    gl.uniform2f(this.uStart, c.startX + ox, c.startY + oy);
    gl.uniform2f(this.uEnd, c.endX + ox, c.endY + oy);
    gl.uniform3f(this.uOwner, c.r, c.g, c.b);
    gl.uniform1f(this.uProgress, c.progress);
    gl.drawArrays(gl.TRIANGLES, 0, this.quad.vertexCount);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteBuffer(this.quad.buffer);
    gl.deleteVertexArray(this.quad.vao);
  }
}
