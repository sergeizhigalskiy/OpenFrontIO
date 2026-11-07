/**
 * ContactShadow — soft dark ellipses on the ground under upright sprites in
 * the isometric view (structure icons, ships, trains), so they sit on the
 * terrain instead of floating over it. Drawn with the sprite pass's own
 * instance VAO, before the sprites, offset a little away from the sun.
 */

import fragSrc from "../shaders/contact-shadow/contact-shadow.frag.glsl?raw";
import vertSrc from "../shaders/contact-shadow/contact-shadow.vert.glsl?raw";
import { createProgram } from "../utils/GlUtils";

/** Where the sun is, for the shadows (null = no shadows this frame). */
export type ShadowLight = readonly [number, number, number] | null;

export class ContactShadow {
  private program: WebGLProgram;
  private uRadius: WebGLUniformLocation | null;
  private uShift: WebGLUniformLocation | null;
  private uStrength: WebGLUniformLocation | null;

  constructor(private gl: WebGL2RenderingContext) {
    this.program = createProgram(gl, vertSrc, fragSrc, "ContactShadow");
    this.uRadius = gl.getUniformLocation(this.program, "uRadius");
    this.uShift = gl.getUniformLocation(this.program, "uShift");
    this.uStrength = gl.getUniformLocation(this.program, "uStrength");
  }

  /**
   * Draw `count` shadows of `radius` tiles with the instance VAO `vao`,
   * cast from the sun direction `light` (unit vector toward the sun).
   * Blending must be on; leaves this program bound.
   */
  draw(
    vao: WebGLVertexArrayObject,
    count: number,
    radius: number,
    strength: number,
    light: readonly [number, number, number],
  ): void {
    if (count === 0 || radius <= 0) return;
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.uniform1f(this.uRadius, radius);
    // Shadows fall away from the sun, longer when it is low.
    const horiz = Math.hypot(light[0], light[1]);
    const reach = horiz > 1e-6 ? (radius * 0.45) / Math.max(light[2], 0.3) : 0;
    gl.uniform2f(
      this.uShift,
      horiz > 1e-6 ? (-light[0] / horiz) * reach : 0,
      horiz > 1e-6 ? (-light[1] / horiz) * reach : 0,
    );
    gl.uniform1f(this.uStrength, strength);
    gl.bindVertexArray(vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
  }

  dispose(): void {
    this.gl.deleteProgram(this.program);
  }
}
