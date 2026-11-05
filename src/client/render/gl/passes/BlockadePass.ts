/**
 * BlockadePass — a red dashed ring around every blockaded port: a hostile
 * warship is within BLOCKADE_RANGE of it (engine-lib game/TradeRoutes), so it
 * sends no trade ships and none come to it.
 *
 * Everyone sees it, like the warships that cause it. One draw call per port;
 * only blockaded ones are drawn.
 */

import { createProgram } from "../utils/GlUtils";

import fragSrc from "../shaders/blockade/blockade.frag.glsl?raw";
import vertSrc from "../shaders/blockade/blockade.vert.glsl?raw";

/** Ring radius in tiles: just outside the port's icon. */
const BLOCKADE_RING_RADIUS = 5;

/** A blockaded port's tile. */
export interface BlockadeMarker {
  x: number;
  y: number;
}

export class BlockadePass {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private quadBuf: WebGLBuffer;

  private uCamera: WebGLUniformLocation;
  private uCenter: WebGLUniformLocation;
  private uRadius: WebGLUniformLocation;

  private ports: BlockadeMarker[] = [];

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = createProgram(gl, vertSrc, fragSrc, "BlockadePass");

    this.uCamera = gl.getUniformLocation(this.program, "uCamera")!;
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

  update(ports: BlockadeMarker[]): void {
    this.ports = ports;
  }

  draw(cameraMatrix: Float32Array): void {
    if (this.ports.length === 0) return;
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.uniformMatrix3fv(this.uCamera, false, cameraMatrix);
    gl.uniform1f(this.uRadius, BLOCKADE_RING_RADIUS);
    gl.bindVertexArray(this.vao);
    for (const p of this.ports) {
      gl.uniform2f(this.uCenter, p.x, p.y);
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
