/**
 * SmallPlayerRingPass — a pulsing ring, constant in screen pixels, around
 * each small player's territory (the players SmallPlayerGlowPass glows),
 * so a remnant of a few tiles can be found from a zoomed-out map. It sits
 * at the player's name position on the ground and draws over everything
 * on the map (no depth test), so a ridge can't hide it. It fades out as
 * you zoom in, where the territory itself, its glow and its label are
 * plain to see. Strength and colour are the small-player glow's.
 */

import type { RenderSettings } from "../RenderSettings";
import fragSrc from "../shaders/small-player-glow/ring.frag.glsl?raw";
import vertSrc from "../shaders/small-player-glow/ring.vert.glsl?raw";
import { createProgram } from "../utils/GlUtils";

/** A small player's marker: their name position, tiles. */
export interface SmallPlayerMarker {
  x: number;
  y: number;
}

/** Ring radius, px, and how far the pulse swells it. */
const RING_RADIUS_PX = 15;
const RING_PULSE_PX = 4;
/** Pixels per tile over which the ring fades out as you zoom in. */
const FADE_FROM_TILE_PX = 5;
const FADE_TO_TILE_PX = 12;

/** Ring opacity for the zoom (`tilePx`: pixels per tile). */
export function smallPlayerRingFade(tilePx: number): number {
  const t = Math.min(
    1,
    Math.max(
      0,
      (tilePx - FADE_FROM_TILE_PX) / (FADE_TO_TILE_PX - FADE_FROM_TILE_PX),
    ),
  );
  return 1 - t * t * (3 - 2 * t);
}

export class SmallPlayerRingPass {
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private instanceBuf: WebGLBuffer;
  private capacity = 0;
  private count = 0;
  private uViewport: WebGLUniformLocation;
  private uRadiusPx: WebGLUniformLocation;
  private uMarginPx: WebGLUniformLocation;
  private uColor: WebGLUniformLocation;
  private uAlpha: WebGLUniformLocation;
  private startTime = performance.now();

  constructor(
    private gl: WebGL2RenderingContext,
    private settings: RenderSettings["smallPlayerGlow"],
  ) {
    this.program = createProgram(gl, vertSrc, fragSrc, "SmallPlayerRingPass");
    this.uViewport = gl.getUniformLocation(this.program, "uViewport")!;
    this.uRadiusPx = gl.getUniformLocation(this.program, "uRadiusPx")!;
    this.uMarginPx = gl.getUniformLocation(this.program, "uMarginPx")!;
    this.uColor = gl.getUniformLocation(this.program, "uColor")!;
    this.uAlpha = gl.getUniformLocation(this.program, "uAlpha")!;

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, -1, 1, 1, -1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.instanceBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  /** The small players' markers (none hides the rings). */
  update(markers: readonly SmallPlayerMarker[]): void {
    this.count = markers.length;
    if (this.count === 0) return;
    const data = new Float32Array(this.count * 2);
    markers.forEach((m, i) => {
      data[i * 2] = m.x;
      data[i * 2 + 1] = m.y;
    });
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
    if (data.byteLength > this.capacity) {
      this.capacity = data.byteLength;
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    } else {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  /**
   * Draw the rings. `tilePx` is the zoom (pixels per tile at the focus).
   * Expects blending on.
   */
  draw(tilePx: number): void {
    const strength = Math.min(1, this.settings.strength);
    if (this.count === 0 || strength <= 0) return;
    const fade = smallPlayerRingFade(tilePx);
    if (fade <= 0) return;
    const gl = this.gl;
    const t = (performance.now() - this.startTime) / 1000;
    const pulse = 0.5 + 0.5 * Math.sin(t * 2.4);
    const radius = RING_RADIUS_PX + RING_PULSE_PX * pulse;
    gl.useProgram(this.program);
    gl.uniform2f(this.uViewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform1f(this.uRadiusPx, radius);
    gl.uniform1f(this.uMarginPx, 4);
    const c = this.settings.color;
    gl.uniform3f(this.uColor, c[0], c[1], c[2]);
    // At least clearly visible whatever the glow's strength, once it's on.
    gl.uniform1f(this.uAlpha, fade * Math.max(0.75, strength));
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.count);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteBuffer(this.instanceBuf);
    gl.deleteVertexArray(this.vao);
  }
}
