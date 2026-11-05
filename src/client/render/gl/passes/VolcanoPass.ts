/**
 * VolcanoPass — a volcano icon on every volcano site (volcanoes mode), always
 * visible, that throbs red while the site rumbles, plus a lava glow that
 * sweeps over the eruption radius when it erupts. The warning ring itself is
 * drawn by NukeTelegraphPass and the blast by the FX pass.
 *
 * One draw call per site and per live eruption; there are at most four sites.
 */

import { VOLCANO_ERUPTION_RADIUS } from "@openfront/engine-lib/game/Volcanoes";
import { createProgram } from "../utils/GlUtils";

import fragSrc from "../shaders/volcano/volcano.frag.glsl?raw";
import vertSrc from "../shaders/volcano/volcano.vert.glsl?raw";

/** Icon radius in tiles. */
const VOLCANO_ICON_RADIUS = 7;
/** How long the eruption glow lasts. */
const ERUPTION_GLOW_MS = 5000;

/** A volcano site to draw. */
export interface VolcanoMarker {
  x: number;
  y: number;
  rumbling: boolean;
}

export class VolcanoPass {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private quadBuf: WebGLBuffer;

  private uCamera: WebGLUniformLocation;
  private uCenter: WebGLUniformLocation;
  private uRadius: WebGLUniformLocation;
  private uMode: WebGLUniformLocation;
  private uTime: WebGLUniformLocation;
  private uRumble: WebGLUniformLocation;
  private uAge: WebGLUniformLocation;

  private markers: VolcanoMarker[] = [];
  private eruptions: { x: number; y: number; startMs: number }[] = [];
  private startTime = performance.now();

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = createProgram(gl, vertSrc, fragSrc, "VolcanoPass");

    this.uCamera = gl.getUniformLocation(this.program, "uCamera")!;
    this.uCenter = gl.getUniformLocation(this.program, "uCenter")!;
    this.uRadius = gl.getUniformLocation(this.program, "uRadius")!;
    this.uMode = gl.getUniformLocation(this.program, "uMode")!;
    this.uTime = gl.getUniformLocation(this.program, "uTime")!;
    this.uRumble = gl.getUniformLocation(this.program, "uRumble")!;
    this.uAge = gl.getUniformLocation(this.program, "uAge")!;

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

  update(markers: VolcanoMarker[]): void {
    this.markers = markers;
  }

  /** Starts the eruption glow at a site. */
  erupt(x: number, y: number): void {
    this.eruptions.push({ x, y, startMs: performance.now() });
  }

  draw(cameraMatrix: Float32Array): void {
    const now = performance.now();
    this.eruptions = this.eruptions.filter(
      (e) => now - e.startMs < ERUPTION_GLOW_MS,
    );
    if (this.markers.length === 0 && this.eruptions.length === 0) return;
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.uniformMatrix3fv(this.uCamera, false, cameraMatrix);
    gl.uniform1f(this.uTime, (now - this.startTime) / 1000);
    gl.bindVertexArray(this.vao);

    gl.uniform1i(this.uMode, 1);
    gl.uniform1f(this.uRadius, VOLCANO_ERUPTION_RADIUS);
    for (const e of this.eruptions) {
      gl.uniform2f(this.uCenter, e.x, e.y);
      gl.uniform1f(this.uAge, (now - e.startMs) / ERUPTION_GLOW_MS);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    gl.uniform1i(this.uMode, 0);
    gl.uniform1f(this.uRadius, VOLCANO_ICON_RADIUS);
    for (const m of this.markers) {
      gl.uniform2f(this.uCenter, m.x, m.y);
      gl.uniform1f(this.uRumble, m.rumbling ? 1 : 0);
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
