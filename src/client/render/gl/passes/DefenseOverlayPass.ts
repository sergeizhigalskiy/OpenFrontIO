/**
 * DefenseOverlayPass — shows where defense posts protect their owner's
 * ground: a bright gold outline in a dark casing around each covered area
 * and a light diagonal hatch across it (shaders/defense-coverage/
 * defense-overlay.frag.glsl). It reads DefenseCoveragePass's coverage
 * texture, so it shows exactly the tiles the engine defends.
 *
 * It drapes on the map surface like the borders (drawMapSurface), so on
 * relief it lies on the ground at every camera angle; where a ridge stands
 * between the camera and the coverage it still shows, faintly, through
 * the ridge (a see-through draw), so a front behind a mountain can't hide
 * it. In the flat view it draws on the map quad.
 */

import fragSrc from "../shaders/defense-coverage/defense-overlay.frag.glsl?raw";
import vertSrc from "../shaders/map-overlay/overlay.vert.glsl?raw";
import { drawMapSurface } from "../terrain/MapSurface";
import { createMapQuad, createProgram } from "../utils/GlUtils";

/** Opacity of the coverage hidden behind a ridge. */
export const DEFENSE_HIDDEN_OPACITY = 0.38;

export class DefenseOverlayPass {
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private uOpacity: WebGLUniformLocation;

  constructor(
    private gl: WebGL2RenderingContext,
    private mapW: number,
    private mapH: number,
  ) {
    this.program = createProgram(gl, vertSrc, fragSrc, "DefenseOverlayPass");
    gl.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, "uCoverage"), 0);
    gl.uniform2f(
      gl.getUniformLocation(this.program, "uMapSize"),
      this.mapW,
      this.mapH,
    );
    this.uOpacity = gl.getUniformLocation(this.program, "uOpacity")!;
    this.vao = createMapQuad(gl, mapW, mapH);
  }

  /**
   * Draw the coverage in `coverageTex`. Skipped when no post stands
   * (`posts` is 0). Expects blending on.
   */
  draw(coverageTex: WebGLTexture, posts: number): void {
    if (posts <= 0) return;
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.uniform1f(this.uOpacity, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, coverageTex);
    drawMapSurface(gl, this.vao, (hidden) =>
      gl.uniform1f(this.uOpacity, hidden ? DEFENSE_HIDDEN_OPACITY : 1),
    );
  }

  dispose(): void {
    this.gl.deleteProgram(this.program);
    this.gl.deleteVertexArray(this.vao);
  }
}
