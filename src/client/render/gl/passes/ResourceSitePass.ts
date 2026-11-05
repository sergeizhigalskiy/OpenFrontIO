/**
 * ResourceSitePass — an icon on every resource site (gold mine) for every
 * player, ringed with its holder's territory color (grey when unheld).
 *
 * Sites are public, like the land they sit on. The icon keeps a readable
 * size on screen at every zoom: its world radius grows when zoomed out and
 * shrinks when zoomed in, within MIN/MAX_SCREEN_RADIUS_PX. One draw call
 * per site; there are at most a couple dozen.
 */

import { createProgram } from "../utils/GlUtils";

import fragSrc from "../shaders/resource-site/resource-site.frag.glsl?raw";
import vertSrc from "../shaders/resource-site/resource-site.vert.glsl?raw";

/** Icon radius in tiles at medium zoom. */
const SITE_RADIUS_TILES = 4;
/** Screen radius bounds (canvas pixels), so it reads at every zoom. */
const MIN_SCREEN_RADIUS_PX = 7;
const MAX_SCREEN_RADIUS_PX = 22;

/** A site to draw: its tile, and its holder's color (0-1) when held. */
export interface ResourceSiteMarker {
  x: number;
  y: number;
  owned: boolean;
  r: number;
  g: number;
  b: number;
}

/** The icon's world radius at `zoom` (canvas pixels per tile). */
export function resourceSiteRadius(zoom: number): number {
  const z = Math.max(zoom, 1e-6);
  return Math.max(
    MIN_SCREEN_RADIUS_PX / z,
    Math.min(SITE_RADIUS_TILES, MAX_SCREEN_RADIUS_PX / z),
  );
}

export class ResourceSitePass {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private quadBuf: WebGLBuffer;

  private uCamera: WebGLUniformLocation;
  private uCenter: WebGLUniformLocation;
  private uRadius: WebGLUniformLocation;
  private uRing: WebGLUniformLocation;
  private uOwned: WebGLUniformLocation;

  private sites: ResourceSiteMarker[] = [];

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = createProgram(gl, vertSrc, fragSrc, "ResourceSitePass");

    this.uCamera = gl.getUniformLocation(this.program, "uCamera")!;
    this.uCenter = gl.getUniformLocation(this.program, "uCenter")!;
    this.uRadius = gl.getUniformLocation(this.program, "uRadius")!;
    this.uRing = gl.getUniformLocation(this.program, "uRing")!;
    this.uOwned = gl.getUniformLocation(this.program, "uOwned")!;

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

  update(sites: ResourceSiteMarker[]): void {
    this.sites = sites;
  }

  draw(cameraMatrix: Float32Array, zoom: number): void {
    if (this.sites.length === 0) return;
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.uniformMatrix3fv(this.uCamera, false, cameraMatrix);
    gl.uniform1f(this.uRadius, resourceSiteRadius(zoom));
    gl.bindVertexArray(this.vao);
    for (const s of this.sites) {
      gl.uniform2f(this.uCenter, s.x, s.y);
      gl.uniform3f(this.uRing, s.r, s.g, s.b);
      gl.uniform1f(this.uOwned, s.owned ? 1 : 0);
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
