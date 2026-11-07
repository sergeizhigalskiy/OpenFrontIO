/**
 * RangeCirclePass — draws a translucent circle showing the effective
 * range of a structure during build-mode ghost preview. White by default,
 * red when the ghost flags a warning (e.g. nuking would break an alliance).
 *
 * The circle is computed per fragment on the map surface (drawMapSurface),
 * so on relief it lies on the ground over every hill, its edge line at a
 * constant on-screen width; where a ridge stands in front of it, it shows
 * through faintly. In the flat view it draws on the map quad.
 * Active only when a ghost preview with rangeRadius > 0 is set.
 */

import type { GhostPreviewData } from "../../types";
import vertSrc from "../shaders/map-overlay/overlay.vert.glsl?raw";
import fragSrc from "../shaders/range-circle/range-circle.frag.glsl?raw";
import { drawMapSurface } from "../terrain/MapSurface";
import { createMapQuad, createProgram } from "../utils/GlUtils";

/** Opacity of the circle hidden behind a ridge. */
const HIDDEN_OPACITY = 0.4;

export class RangeCirclePass {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;

  private uCenter: WebGLUniformLocation;
  private uRadius: WebGLUniformLocation;
  private uColor: WebGLUniformLocation;
  private uOpacity: WebGLUniformLocation;

  private centerX = 0;
  private centerY = 0;
  private radius = 0;
  private warning = false;

  constructor(gl: WebGL2RenderingContext, mapW: number, mapH: number) {
    this.gl = gl;
    this.program = createProgram(gl, vertSrc, fragSrc, "RangeCirclePass");

    this.uCenter = gl.getUniformLocation(this.program, "uCenter")!;
    this.uRadius = gl.getUniformLocation(this.program, "uRadius")!;
    this.uColor = gl.getUniformLocation(this.program, "uColor")!;
    this.uOpacity = gl.getUniformLocation(this.program, "uOpacity")!;

    this.vao = createMapQuad(gl, mapW, mapH);
  }

  updateGhostPreview(data: GhostPreviewData | null): void {
    if (data && data.rangeRadius > 0) {
      this.centerX = data.radiusTileX;
      this.centerY = data.radiusTileY;
      this.radius = data.rangeRadius;
      this.warning = data.rangeWarning;
    } else {
      this.radius = 0;
      this.warning = false;
    }
  }

  draw(cameraMatrix: Float32Array): void {
    if (this.radius <= 0) return;

    const gl = this.gl;
    gl.useProgram(this.program);

    gl.uniform2f(this.uCenter, this.centerX + 0.5, this.centerY + 0.5);
    gl.uniform1f(this.uRadius, this.radius);
    if (this.warning) {
      gl.uniform3f(this.uColor, 1.0, 0.2, 0.2);
    } else {
      gl.uniform3f(this.uColor, 1.0, 1.0, 1.0);
    }
    gl.uniform1f(this.uOpacity, 1);
    drawMapSurface(gl, this.vao, (hidden) =>
      gl.uniform1f(this.uOpacity, hidden ? HIDDEN_OPACITY : 1),
    );
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
  }
}
